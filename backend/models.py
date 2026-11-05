"""
Pydantic v2 schemas for Yggdrasil.

Naming convention
  XCreate / XBase : what the client sends
  X               : the full document stored in Firestore (adds id, server-managed fields)

Every model has .to_firestore() which returns a plain dict (enums as strings,
datetimes kept as datetime so Firestore stores real timestamps, `id` excluded
because it is the document ID).
"""
import secrets
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    field_validator,
    model_validator,
)

# ==========================================================================
# Constants and enums
# ==========================================================================
PHONE_PATTERN = r"^\+?[0-9]{7,15}$"
RARE_POINTS_MULTIPLIER = 5
REPORT_HIDE_THRESHOLD = 5  # a post is auto-hidden after this many reports


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class BloodGroup(str, Enum):
    A_POS = "A+"
    A_NEG = "A-"
    B_POS = "B+"
    B_NEG = "B-"
    AB_POS = "AB+"
    AB_NEG = "AB-"
    O_POS = "O+"
    O_NEG = "O-"


# Plain strings on purpose: Enum members hash by name, so `"O-" in {BloodGroup.O_NEG}`
# would be False. Edit this set to change which groups count as rare.
RARE_BLOOD_GROUPS = frozenset({"A-", "B-", "AB-", "O-"})


class RequestStatus(str, Enum):
    OPEN = "open"
    CRITERIA_FULFILLED = "criteria_fulfilled"  # also used as "accepted" for hospital requests
    REJECTED_BLOOD_NA = "rejected_blood_na"
    REJECTED_SERVICE_NA = "rejected_service_na"


class FulfilmentMode(str, Enum):
    DELIVERY = "delivery"
    PICKUP = "pickup"


class ScanState(str, Enum):
    REGISTERED = "registered"
    CHECKED_IN = "checked_in"  # Scan 1 done
    COMPLETED = "completed"  # Scan 2 done


class DonorMode(str, Enum):
    PUBLIC = "public"
    PRIVATE = "private"
    BOTH = "both"


class FacilityType(str, Enum):
    CLINIC = "clinic"
    HOSPITAL = "hospital"


class FeedbackRole(str, Enum):
    DONOR = "donor"
    BLOOD_BANK = "blood_bank"


# ==========================================================================
# Shared bases
# ==========================================================================
class AppModel(BaseModel):
    # validate_default=True makes enum defaults go through use_enum_values too,
    # so Firestore always receives plain strings.
    model_config = ConfigDict(
        use_enum_values=True,
        str_strip_whitespace=True,
        validate_default=True,
    )

    def to_firestore(self) -> dict:
        return self.model_dump(exclude={"id"})


class Located(AppModel):
    """Coordinates plus a region string used for cheap Firestore pre-filtering
    (`where("region", "==", ...)`) before exact geopy distance checks."""

    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    region: str = Field(min_length=2, max_length=80, description="City or region name")

    @field_validator("region")
    @classmethod
    def _normalise_region(cls, v: str) -> str:
        # Lowercase so Firestore equality filters match regardless of input casing.
        return v.strip().lower()

    @property
    def coords(self) -> tuple[float, float]:
        return (self.lat, self.lng)


# ==========================================================================
# 1. Donor
# ==========================================================================
class DonorBase(Located):
    name: str = Field(min_length=2, max_length=100)
    email: EmailStr
    phone: str = Field(pattern=PHONE_PATTERN)
    age: int = Field(ge=18, le=120, description="Donors must be 18 or older")
    blood_group: BloodGroup
    has_hiv_or_aids: bool = Field(description="Health declaration; must be False to register")
    profile_image_url: Optional[str] = None  # Cloudinary secure_url

    @field_validator("has_hiv_or_aids")
    @classmethod
    def _must_be_eligible(cls, v: bool) -> bool:
        if v:
            raise ValueError("Donor is not eligible to register based on the health declaration")
        return v


class DonorCreate(DonorBase):
    """Registration payload."""


class Donor(DonorBase):
    """Stored donor document."""

    id: Optional[str] = None

    # Gamification (server-managed)
    is_rare_shiny: bool = False
    points_multiplier: int = Field(default=1, ge=1)
    total_points: int = Field(default=0, ge=0)

    # Organisations
    affiliated_org_ids: list[str] = Field(default_factory=list)
    pending_org_ids: list[str] = Field(default_factory=list)  # join requests awaiting approval

    # Onboarding
    guide_completed: bool = False

    created_at: datetime = Field(default_factory=utcnow)

    @model_validator(mode="after")
    def _apply_rarity(self) -> "Donor":
        group = getattr(self.blood_group, "value", self.blood_group)
        self.is_rare_shiny = group in RARE_BLOOD_GROUPS
        self.points_multiplier = RARE_POINTS_MULTIPLIER if self.is_rare_shiny else 1
        return self


# ==========================================================================
# 2. Blood bank
# ==========================================================================
class PrivateDonor(AppModel):
    """Entry in a blood bank's private donor list."""

    name: str = Field(min_length=2, max_length=100)
    phone: str = Field(pattern=PHONE_PATTERN, description="Used for the SMS fallback")
    blood_group: Optional[BloodGroup] = None
    is_app_user: bool = False
    donor_id: Optional[str] = None  # set when the phone matches a registered Donor
    added_at: datetime = Field(default_factory=utcnow)

    @property
    def notification_channel(self) -> str:
        """'app' for app users, otherwise 'sms'."""
        return "app" if self.is_app_user else "sms"


class BloodBankBase(Located):
    name: str = Field(min_length=2, max_length=150)
    registration_number: Optional[str] = None
    email: EmailStr
    phone: str = Field(pattern=PHONE_PATTERN)
    address: str = Field(min_length=5, max_length=300)
    hosts_camps: bool = False
    donor_mode: DonorMode = DonorMode.PUBLIC
    logo_url: Optional[str] = None  # Cloudinary secure_url


class BloodBankCreate(BloodBankBase):
    """Registration payload."""


class BloodBank(BloodBankBase):
    id: Optional[str] = None
    private_donors: list[PrivateDonor] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utcnow)


# ==========================================================================
# 3. Requestor (clinic / hospital)
# ==========================================================================
class RequestorBase(Located):
    facility_name: str = Field(min_length=2, max_length=150)
    facility_type: FacilityType
    registration_number: Optional[str] = None
    contact_person: str = Field(min_length=2, max_length=100)
    email: EmailStr
    phone: str = Field(pattern=PHONE_PATTERN)
    address: str = Field(min_length=5, max_length=300)


class RequestorCreate(RequestorBase):
    """Registration payload."""


class Requestor(RequestorBase):
    id: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)


# ==========================================================================
# 5 (defined early, used by quests). Dual-QR check-in state machine
# ==========================================================================
class CheckInRecord(AppModel):
    """
    One donor's progress through the dual-scan flow:

        registered --scan_in()--> checked_in --scan_out()--> completed

    Scan 1 stamps `checked_in_at`. Scan 2 stamps `completed_at`, logs the
    `blood_bag_id` and awards base_points * the donor's multiplier.
    """

    donor_id: str
    donor_name: Optional[str] = None
    state: ScanState = ScanState.REGISTERED
    registered_at: datetime = Field(default_factory=utcnow)
    checked_in_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    blood_bag_id: Optional[str] = None
    points_awarded: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def _check_consistency(self) -> "CheckInRecord":
        if self.state in (ScanState.CHECKED_IN, ScanState.COMPLETED) and not self.checked_in_at:
            raise ValueError("checked_in_at is required once a donor has checked in")
        if self.state == ScanState.COMPLETED:
            if not self.completed_at or not self.blood_bag_id:
                raise ValueError("completed_at and blood_bag_id are required when completed")
            if self.completed_at < self.checked_in_at:
                raise ValueError("completed_at cannot be earlier than checked_in_at")
        return self

    def scan_in(self, at: Optional[datetime] = None) -> None:
        """Scan 1: registered -> checked_in."""
        if self.state != ScanState.REGISTERED:
            raise ValueError(f"Cannot check in from state '{self.state}'")
        self.checked_in_at = at or utcnow()
        self.state = ScanState.CHECKED_IN.value

    def scan_out(
        self,
        *,
        blood_bag_id: str,
        base_points: int,
        multiplier: int = 1,
        at: Optional[datetime] = None,
    ) -> int:
        """Scan 2: checked_in -> completed. Returns the points awarded."""
        if self.state != ScanState.CHECKED_IN:
            raise ValueError(f"Cannot complete from state '{self.state}'")
        self.completed_at = at or utcnow()
        self.blood_bag_id = blood_bag_id
        self.points_awarded = base_points * multiplier
        self.state = ScanState.COMPLETED.value
        return self.points_awarded


# ==========================================================================
# 4. EmergencyQuest and HospitalRequest
# ==========================================================================
class Feedback(AppModel):
    from_role: FeedbackRole
    from_id: str
    rating: int = Field(ge=1, le=5)
    comment: Optional[str] = Field(default=None, max_length=500)
    created_at: datetime = Field(default_factory=utcnow)


class RequestBase(AppModel):
    blood_group_needed: BloodGroup
    units_required: int = Field(ge=1, le=50)
    notes: Optional[str] = Field(default=None, max_length=500)
    # Filled in from the frontend's OSRM result (or cached by the backend).
    estimated_distance_km: Optional[float] = Field(default=None, ge=0)
    estimated_time_min: Optional[float] = Field(default=None, ge=0)


class EmergencyQuestCreate(Located, RequestBase):
    """Blood bank asks nearby public donors for help. lat/lng is where donors should go."""

    blood_bank_id: str
    search_radius_km: float = Field(default=10.0, gt=0, le=200)


class EmergencyQuest(EmergencyQuestCreate):
    id: Optional[str] = None
    status: RequestStatus = RequestStatus.OPEN
    accepted_donor_ids: list[str] = Field(default_factory=list)
    accepted_donors_count: int = Field(default=0, ge=0)
    checkins: list[CheckInRecord] = Field(default_factory=list)  # dual-QR per donor
    feedback: list[Feedback] = Field(default_factory=list)  # donor <-> blood bank
    created_at: datetime = Field(default_factory=utcnow)
    fulfilled_at: Optional[datetime] = None

    @field_validator("accepted_donor_ids")
    @classmethod
    def _dedupe(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(v))

    @model_validator(mode="after")
    def _sync_count_and_status(self) -> "EmergencyQuest":
        self.accepted_donors_count = len(self.accepted_donor_ids)
        if (
            self.status == RequestStatus.OPEN
            and self.accepted_donors_count >= self.units_required
        ):
            self.status = RequestStatus.CRITERIA_FULFILLED.value
            self.fulfilled_at = self.fulfilled_at or utcnow()
        return self


class HospitalRequestCreate(RequestBase):
    """A clinic or hospital asks a blood bank for blood."""

    requestor_id: str
    blood_bank_id: str
    fulfilment_mode: FulfilmentMode


class HospitalRequest(HospitalRequestCreate):
    id: Optional[str] = None
    status: RequestStatus = RequestStatus.OPEN
    rejection_reason: Optional[str] = Field(default=None, max_length=300)
    created_at: datetime = Field(default_factory=utcnow)
    responded_at: Optional[datetime] = None


# ==========================================================================
# 5. Camp
# ==========================================================================
class CampCreate(Located):
    blood_bank_id: str
    title: str = Field(min_length=3, max_length=150)
    description: Optional[str] = Field(default=None, max_length=1000)
    venue: str = Field(min_length=3, max_length=200)
    start_time: datetime
    end_time: datetime
    capacity: Optional[int] = Field(default=None, ge=1)
    community_service_points: int = Field(default=50, ge=0, description="Base points before multiplier")

    @model_validator(mode="after")
    def _check_times(self) -> "CampCreate":
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


class Camp(CampCreate):
    id: Optional[str] = None
    # Same token is shown in the QR for both scans; the backend decides which
    # scan it is from the donor's current state.
    qr_token: str = Field(default_factory=lambda: secrets.token_urlsafe(16))
    registrations: list[CheckInRecord] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utcnow)

    @model_validator(mode="after")
    def _check_capacity(self) -> "Camp":
        if self.capacity is not None and len(self.registrations) > self.capacity:
            raise ValueError("Registrations exceed camp capacity")
        return self

    @property
    def registered_count(self) -> int:
        return len(self.registrations)

    def record_for(self, donor_id: str) -> Optional[CheckInRecord]:
        return next((r for r in self.registrations if r.donor_id == donor_id), None)


# ==========================================================================
# 6. Community post
# ==========================================================================
class Comment(AppModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    author_id: str
    author_name: str
    text: str = Field(min_length=1, max_length=500)
    created_at: datetime = Field(default_factory=utcnow)


class ReportFlag(AppModel):
    reported_by: str
    reason: str = Field(min_length=3, max_length=300)
    created_at: datetime = Field(default_factory=utcnow)


class CommunityPostCreate(AppModel):
    """Text fields. The image is uploaded as multipart and its URL is added server-side."""

    author_id: str
    author_name: str
    content: str = Field(min_length=1, max_length=2000)


class CommunityPost(CommunityPostCreate):
    id: Optional[str] = None
    image_url: Optional[str] = None  # Cloudinary secure_url
    liked_by: list[str] = Field(default_factory=list)  # one like per user
    likes_count: int = Field(default=0, ge=0)
    shares_count: int = Field(default=0, ge=0)
    comments: list[Comment] = Field(default_factory=list)
    reports: list[ReportFlag] = Field(default_factory=list)
    report_count: int = Field(default=0, ge=0)
    is_hidden: bool = False  # auto-set once reports reach the threshold
    created_at: datetime = Field(default_factory=utcnow)

    @field_validator("liked_by")
    @classmethod
    def _dedupe_likes(cls, v: list[str]) -> list[str]:
        return list(dict.fromkeys(v))

    @model_validator(mode="after")
    def _sync_counters(self) -> "CommunityPost":
        self.likes_count = len(self.liked_by)
        self.report_count = len(self.reports)
        if self.report_count >= REPORT_HIDE_THRESHOLD:
            self.is_hidden = True
        return self
