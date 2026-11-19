"""
Donor endpoints for Yggdrasil.

Mounted by main.py as:  app.include_router(donors.router)   (prefix: /donors)

Design notes
  * Firestore's Python client is synchronous, so every endpoint is a plain `def`
    (FastAPI runs those in a threadpool). The only `async def` is the avatar
    upload, which wraps its Firestore calls in run_in_threadpool.
  * Read-modify-write flows (accept quest, camp registration) run inside
    Firestore transactions so two donors can never over-fill a quest or camp.
  * Registration uses its own request model (DonorRegistration) so that the
    medical-eligibility rules produce the HTTP 400 requested, rather than the
    422 that DonorCreate's built-in validators would raise. The validated result
    is still built with the real `Donor` model, so rarity and points-multiplier
    logic stays in one place.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from pydantic import BaseModel, Field

from config import Collections, db
from models import (
    PHONE_PATTERN,
    RARE_BLOOD_GROUPS,
    RARE_POINTS_MULTIPLIER,
    BloodGroup,
    CheckInRecord,
    Donor,
    Located,
    RequestStatus,
    utcnow,
)
from utils import filter_by_radius, upload_image

router = APIRouter(prefix="/donors", tags=["Donors"])

NEARBY_RADIUS_KM = 25.0
LEADERBOARD_LIMIT = 20
MIN_DONOR_AGE = 18

# Not yet in config.Collections; add `APPOINTMENTS = "appointments"` there if you like.
APPOINTMENTS = getattr(Collections, "APPOINTMENTS", "appointments")

# Which recipient groups each donor group can give to (standard ABO/Rh rules).
CAN_DONATE_TO: dict[str, frozenset[str]] = {
    "O-": frozenset({"O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"}),
    "O+": frozenset({"O+", "A+", "B+", "AB+"}),
    "A-": frozenset({"A-", "A+", "AB-", "AB+"}),
    "A+": frozenset({"A+", "AB+"}),
    "B-": frozenset({"B-", "B+", "AB-", "AB+"}),
    "B+": frozenset({"B+", "AB+"}),
    "AB-": frozenset({"AB-", "AB+"}),
    "AB+": frozenset({"AB+"}),
}


# ==========================================================================
# Request schemas (local to this router)
# ==========================================================================
class DonorRegistration(Located):
    """
    Same fields as DonorCreate, minus the eligibility validators, so that the
    endpoint can reject ineligible donors with a clear HTTP 400 message.
    """

    name: str = Field(min_length=2, max_length=100)
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    phone: str = Field(pattern=PHONE_PATTERN)
    age: int = Field(ge=0, le=120)
    blood_group: BloodGroup
    has_hiv_or_aids: bool
    profile_image_url: Optional[str] = None


class CampRegistrationRequest(BaseModel):
    donor_id: str


class AppointmentRequest(BaseModel):
    donor_id: str
    blood_bank_id: str
    scheduled_at: datetime = Field(description="ISO 8601 date-time of the appointment")
    notes: Optional[str] = Field(default=None, max_length=300)


# ==========================================================================
# Helpers
# ==========================================================================
def _get_donor_or_404(donor_id: str) -> dict:
    snap = db.collection(Collections.DONORS).document(donor_id).get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Donor not found")
    return {**snap.to_dict(), "id": snap.id}


def _with_id(snap) -> dict:
    return {**snap.to_dict(), "id": snap.id}


def _as_aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _public_donor(donor: dict) -> dict:
    """Donor profile as returned to the client."""
    return donor


def _public_blood_bank(bank: dict, donor: dict) -> dict:
    return {
        "id": bank["id"],
        "name": bank.get("name"),
        "address": bank.get("address"),
        "phone": bank.get("phone"),
        "email": bank.get("email"),
        "region": bank.get("region"),
        "lat": bank.get("lat"),
        "lng": bank.get("lng"),
        "logo_url": bank.get("logo_url"),
        "hosts_camps": bank.get("hosts_camps", False),
        "donor_mode": bank.get("donor_mode"),
        "distance_km": bank["distance_km"],
        "is_member": bank["id"] in donor.get("affiliated_org_ids", []),
        "join_pending": bank["id"] in donor.get("pending_org_ids", []),
        # private_donors is deliberately never exposed here.
    }


def _public_quest(quest: dict, donor_id: str) -> dict:
    return {
        "id": quest["id"],
        "blood_bank_id": quest.get("blood_bank_id"),
        "blood_group_needed": quest.get("blood_group_needed"),
        "units_required": quest.get("units_required"),
        "accepted_donors_count": quest.get("accepted_donors_count", 0),
        "status": quest.get("status"),
        "notes": quest.get("notes"),
        "lat": quest.get("lat"),
        "lng": quest.get("lng"),
        "region": quest.get("region"),
        "distance_km": quest["distance_km"],
        "created_at": quest.get("created_at"),
        "already_accepted": donor_id in quest.get("accepted_donor_ids", []),
    }


# ==========================================================================
# 1. Registration
# ==========================================================================
@router.post("/register", status_code=201)
def register_donor(payload: DonorRegistration) -> dict:
    # --- Medical eligibility -------------------------------------------------
    if payload.age < MIN_DONOR_AGE:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Registration rejected: donors must be at least {MIN_DONOR_AGE} "
                f"years old to donate blood."
            ),
        )
    if payload.has_hiv_or_aids:
        raise HTTPException(
            status_code=400,
            detail=(
                "Registration rejected: based on your health declaration you are "
                "not medically eligible to donate blood. Thank you for wanting to help."
            ),
        )

    donors = db.collection(Collections.DONORS)

    # --- Duplicate guard -----------------------------------------------------
    existing = donors.where(filter=FieldFilter("email", "==", payload.email)).limit(1).get()
    if existing:
        raise HTTPException(status_code=409, detail="A donor with this email is already registered")

    # --- Build the stored document (the Donor model applies the shiny rule) ---
    donor = Donor(**payload.model_dump())
    is_shiny = donor.blood_group in RARE_BLOOD_GROUPS
    donor.is_rare_shiny = is_shiny
    donor.points_multiplier = RARE_POINTS_MULTIPLIER if is_shiny else 1

    ref = donors.document()
    ref.set(donor.to_firestore())
    donor.id = ref.id

    response: dict = {
        "message": "Registration successful. Welcome to Yggdrasil!",
        "donor": _public_donor(donor.model_dump()),
    }
    if donor.is_rare_shiny:
        response["message"] = (
            f"Congratulations! Your blood group {donor.blood_group} is rare, which makes "
            f"you a Shiny Donor. Every point you earn is multiplied by "
            f"{donor.points_multiplier}x."
        )
    return response


# ==========================================================================
# 6. Leaderboard (declared before the /{donor_id}/... routes)
# ==========================================================================
@router.get("/leaderboard")
def leaderboard() -> dict:
    snaps = (
        db.collection(Collections.DONORS)
        .order_by("total_points", direction=firestore.Query.DESCENDING)
        .limit(LEADERBOARD_LIMIT)
        .stream()
    )
    top = []
    for rank, snap in enumerate(snaps, start=1):
        d = snap.to_dict()
        top.append(
            {
                "rank": rank,
                "id": snap.id,
                "name": d.get("name"),
                "blood_group": d.get("blood_group"),
                "total_points": d.get("total_points", 0),
                "is_rare_shiny": d.get("is_rare_shiny", False),
                "points_multiplier": d.get("points_multiplier", 1),
                "profile_image_url": d.get("profile_image_url"),
            }
        )
    return {"count": len(top), "leaderboard": top}


# ==========================================================================
# 7. Camp registration and appointment booking (static paths, before /{donor_id})
# ==========================================================================
@router.post("/camps/{camp_id}/register", status_code=201)
def register_for_camp(camp_id: str, body: CampRegistrationRequest) -> dict:
    donor = _get_donor_or_404(body.donor_id)
    camp_ref = db.collection(Collections.CAMPS).document(camp_id)

    @firestore.transactional
    def _register(txn) -> dict:
        snap = camp_ref.get(transaction=txn)
        if not snap.exists:
            raise HTTPException(status_code=404, detail="Camp not found")
        camp = snap.to_dict()

        end_time = camp.get("end_time")
        if end_time and _as_aware(end_time) < utcnow():
            raise HTTPException(status_code=400, detail="This camp has already ended")

        registrations = camp.get("registrations", [])
        if any(r.get("donor_id") == body.donor_id for r in registrations):
            raise HTTPException(status_code=409, detail="You are already registered for this camp")

        capacity = camp.get("capacity")
        if capacity is not None and len(registrations) >= capacity:
            raise HTTPException(status_code=409, detail="This camp is full")

        # state defaults to "registered" (the initial QR scan status)
        record = CheckInRecord(donor_id=body.donor_id, donor_name=donor.get("name")).to_firestore()
        txn.update(camp_ref, {"registrations": firestore.ArrayUnion([record])})
        return {"camp": camp, "record": record}

    result = _register(db.transaction())
    camp = result["camp"]
    return {
        "message": "You are registered for the camp. Show your QR at check-in.",
        "camp_id": camp_id,
        "camp_title": camp.get("title"),
        "venue": camp.get("venue"),
        "start_time": camp.get("start_time"),
        "qr_status": result["record"]["state"],
        "registration": result["record"],
    }

# ==========================================================================
# Join-request to a blood bank / organisation
# ==========================================================================
@router.post("/{donor_id}/join-org/{bank_id}", status_code=201)
def request_to_join_org(donor_id: str, bank_id: str) -> dict:
    donor_ref = db.collection(Collections.DONORS).document(donor_id)
    bank_ref = db.collection(Collections.BLOOD_BANKS).document(bank_id)

    @firestore.transactional
    def _request(txn) -> str:
        donor_snap = donor_ref.get(transaction=txn)
        if not donor_snap.exists:
            raise HTTPException(status_code=404, detail="Donor not found")
        bank_snap = bank_ref.get(transaction=txn)
        if not bank_snap.exists:
            raise HTTPException(status_code=404, detail="Blood bank not found")

        donor = donor_snap.to_dict()
        if bank_id in donor.get("affiliated_org_ids", []):
            raise HTTPException(status_code=409, detail="You are already a member of this organisation")
        if bank_id in donor.get("pending_org_ids", []):
            raise HTTPException(status_code=409, detail="Your join request is already pending")

        txn.update(donor_ref, {"pending_org_ids": firestore.ArrayUnion([bank_id])})
        return bank_snap.to_dict().get("name")

    bank_name = _request(db.transaction())
    return {
        "message": f"Your request to join {bank_name} has been sent.",
        "donor_id": donor_id,
        "bank_id": bank_id,
        "status": "pending",
    }

@router.post("/appointments/book", status_code=201)
def book_appointment(body: AppointmentRequest) -> dict:
    donor = _get_donor_or_404(body.donor_id)

    bank_snap = db.collection(Collections.BLOOD_BANKS).document(body.blood_bank_id).get()
    if not bank_snap.exists:
        raise HTTPException(status_code=404, detail="Blood bank not found")
    bank = bank_snap.to_dict()

    scheduled_at = _as_aware(body.scheduled_at)
    if scheduled_at <= utcnow():
        raise HTTPException(status_code=400, detail="Appointment time must be in the future")

    appointment = {
        "donor_id": body.donor_id,
        "donor_name": donor.get("name"),
        "blood_group": donor.get("blood_group"),
        "blood_bank_id": body.blood_bank_id,
        "blood_bank_name": bank.get("name"),
        "scheduled_at": scheduled_at,
        "notes": body.notes,
        "status": "scheduled",
        "created_at": utcnow(),
    }
    ref = db.collection(APPOINTMENTS).document()
    ref.set(appointment)

    return {
        "message": f"Appointment booked with {bank.get('name')}.",
        "appointment": {**appointment, "id": ref.id},
    }


# ==========================================================================
# 2. Avatar upload
# ==========================================================================
@router.post("/{donor_id}/upload-avatar")
async def upload_avatar(donor_id: str, file: UploadFile = File(...)) -> dict:
    # Check the donor first so we never upload an image for a missing donor.
    await run_in_threadpool(_get_donor_or_404, donor_id)

    url = await upload_image(file, folder="yggdrasil/profiles")

    await run_in_threadpool(
        db.collection(Collections.DONORS).document(donor_id).update,
        {"profile_image_url": url},
    )
    return {"profile_image_url": url}


# ==========================================================================
# 3. Onboarding guide
# ==========================================================================
@router.patch("/{donor_id}/complete-guide")
def complete_guide(donor_id: str) -> dict:
    _get_donor_or_404(donor_id)
    db.collection(Collections.DONORS).document(donor_id).update({"guide_completed": True})
    return {"donor_id": donor_id, "guide_completed": True}


# ==========================================================================
# 4. Dashboard recommendations
# ==========================================================================
@router.get("/{donor_id}/dashboard-recommendations")
def dashboard_recommendations(donor_id: str) -> dict:
    donor = _get_donor_or_404(donor_id)
    center = (donor["lat"], donor["lng"])
    group = donor["blood_group"]

    # --- Nearby blood banks / organisations ---------------------------------
    # Not pre-filtered by region: 25 km can cross city boundaries.
    banks = [_with_id(s) for s in db.collection(Collections.BLOOD_BANKS).stream()]
    nearby_banks = [
        _public_blood_bank(b, donor) for b in filter_by_radius(banks, center, NEARBY_RADIUS_KM)
    ]

    # --- Open emergency quests this donor can help with ---------------------
    compatible_needs = sorted(CAN_DONATE_TO.get(group, {group}))
    quest_snaps = (
        db.collection(Collections.EMERGENCY_QUESTS)
        .where(filter=FieldFilter("status", "==", RequestStatus.OPEN.value))
        .where(filter=FieldFilter("blood_group_needed", "in", compatible_needs))
        .stream()
    )
    quests = [_with_id(s) for s in quest_snaps]
    nearby_quests = [
        _public_quest(q, donor_id) for q in filter_by_radius(quests, center, NEARBY_RADIUS_KM)
    ]

    return {
        "donor_id": donor_id,
        "blood_group": group,
        "radius_km": NEARBY_RADIUS_KM,
        "blood_banks": nearby_banks,
        "emergency_quests": nearby_quests,
    }


# ==========================================================================
# 5. Accept an emergency quest
# ==========================================================================
@router.post("/{donor_id}/accept-quest/{quest_id}")
def accept_quest(donor_id: str, quest_id: str) -> dict:
    donor_ref = db.collection(Collections.DONORS).document(donor_id)
    quest_ref = db.collection(Collections.EMERGENCY_QUESTS).document(quest_id)

    @firestore.transactional
    def _accept(txn) -> dict:
        donor_snap = donor_ref.get(transaction=txn)
        if not donor_snap.exists:
            raise HTTPException(status_code=404, detail="Donor not found")
        quest_snap = quest_ref.get(transaction=txn)
        if not quest_snap.exists:
            raise HTTPException(status_code=404, detail="Emergency quest not found")

        donor = donor_snap.to_dict()
        quest = quest_snap.to_dict()

        if quest.get("status") != RequestStatus.OPEN.value:
            raise HTTPException(status_code=409, detail="This quest is no longer open")

        needed = quest.get("blood_group_needed")
        if needed not in CAN_DONATE_TO.get(donor["blood_group"], frozenset()):
            raise HTTPException(
                status_code=400,
                detail=f"Your blood group ({donor['blood_group']}) cannot donate to {needed}",
            )

        accepted_ids = quest.get("accepted_donor_ids", [])
        if donor_id in accepted_ids:
            raise HTTPException(status_code=409, detail="You have already accepted this quest")

        new_count = len(accepted_ids) + 1
        updates: dict = {
            "accepted_donor_ids": firestore.ArrayUnion([donor_id]),
            "accepted_donors_count": firestore.Increment(1),
        }
        fulfilled = new_count >= quest.get("units_required", 1)
        if fulfilled:
            updates["status"] = RequestStatus.CRITERIA_FULFILLED.value
            updates["fulfilled_at"] = utcnow()
        txn.update(quest_ref, updates)

        return {
            "accepted_donors_count": new_count,
            "units_required": quest.get("units_required"),
            "status": updates.get("status", RequestStatus.OPEN.value),
            "fulfilled": fulfilled,
        }

    result = _accept(db.transaction())
    return {
        "message": (
            "Thank you! The quest now has all the donors it needs."
            if result["fulfilled"]
            else "Thank you! You have joined this emergency quest."
        ),
        "quest_id": quest_id,
        "donor_id": donor_id,
        **result,
    }
