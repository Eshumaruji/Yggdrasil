"""
Blood bank endpoints for Yggdrasil.

Mounted by main.py as:  app.include_router(blood_banks.router)   (prefix: /blood-banks)

Design notes
  * Firestore's Python client is synchronous, so every endpoint is a plain `def`
    (FastAPI runs those in a threadpool).
  * Read-modify-write flows (private-donor list, QR scans, feedback) run in
    Firestore transactions so concurrent scans or requests cannot corrupt state.
  * Stored documents are built with the real models in models.py. Where an
    endpoint's body differs from the *Create schema (for example the bank id
    comes from the URL), a small local request model is used and the bank id is
    merged in before building the real model.
"""
import logging
from datetime import datetime, timezone
from typing import Callable, Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from pydantic import BaseModel, Field, field_validator, model_validator

from config import Collections, db
from models import (
    RARE_POINTS_MULTIPLIER,
    BloodBank,
    BloodBankCreate,
    BloodGroup,
    Camp,
    CheckInRecord,
    EmergencyQuest,
    Feedback,
    FeedbackRole,
    PrivateDonor,
    RequestBase,
    RequestStatus,
    ScanState,
    utcnow,
)
from utils import distance_km, filter_by_radius

logger = logging.getLogger("yggdrasil.blood_bank")

router = APIRouter(prefix="/blood-banks", tags=["Blood Banks"])

NEARBY_RADIUS_KM = 25.0
AVG_CITY_SPEED_KMH = 35.0  # backend fallback; the frontend refines this with OSRM
QUEST_BASE_POINTS = 100  # camps use their own `community_service_points`
BATCH_LIMIT = 400  # Firestore allows 500 writes per batch

# Not yet in config.Collections. Add these there if you like; until then the
# fallbacks below are used.
NOTIFICATIONS = getattr(Collections, "NOTIFICATIONS", "notifications")
BLOOD_BAGS = getattr(Collections, "BLOOD_BAGS", "blood_bags")

# Donor groups able to give to each recipient group (standard ABO/Rh rules).
DONOR_GROUPS_FOR: dict[str, list[str]] = {
    "O-": ["O-"],
    "O+": ["O-", "O+"],
    "A-": ["O-", "A-"],
    "A+": ["O-", "O+", "A-", "A+"],
    "B-": ["O-", "B-"],
    "B+": ["O-", "O+", "B-", "B+"],
    "AB-": ["O-", "A-", "B-", "AB-"],
    "AB+": ["O-", "O+", "A-", "A+", "B-", "B+", "AB-", "AB+"],
}

# target_type -> (Firestore collection, field holding the per-donor CheckInRecords)
TARGETS = {
    "camp": (Collections.CAMPS, "registrations"),
    "quest": (Collections.EMERGENCY_QUESTS, "checkins"),
}


# ==========================================================================
# SMS fallback (placeholder, plug a real provider in here)
# ==========================================================================
def send_sms_fallback(phone_number: str, message: str) -> dict:
    """
    Send an SMS to someone who is not an app user.

    This is a placeholder: it only logs the message. To go live, replace the
    body with a provider call and keep the returned shape
    ({"status", "provider", "to", ...}) so the endpoint response does not change.

    Twilio:
        from twilio.rest import Client
        client = Client(os.getenv("TWILIO_SID"), os.getenv("TWILIO_TOKEN"))
        msg = client.messages.create(
            to=phone_number, from_=os.getenv("TWILIO_FROM"), body=message
        )
        return {"status": msg.status, "provider": "twilio", "to": phone_number,
                "provider_message_id": msg.sid}

    Fast2SMS:
        resp = requests.post(
            "https://www.fast2sms.com/dev/bulkV2",
            headers={"authorization": os.getenv("FAST2SMS_KEY")},
            json={"route": "q", "message": message, "numbers": phone_number.lstrip("+")},
            timeout=10,
        )
        return {"status": "sent" if resp.ok else "failed", "provider": "fast2sms",
                "to": phone_number}
    """
    logger.info("[SMS placeholder] to=%s message=%s", phone_number, message)
    return {
        "status": "queued_placeholder",
        "provider": "placeholder",
        "to": phone_number,
        "message": message,
    }


# ==========================================================================
# Request schemas (local to this router)
# ==========================================================================
class PrivateDonorRequest(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    phone: str = Field(pattern=r"^\+?[0-9]{7,15}$")
    email: Optional[str] = Field(default=None, description="Only used to match an app user")
    blood_group: Optional[BloodGroup] = None


class EmergencyQuestRequest(RequestBase):
    """Quest details. Location defaults to the blood bank's own."""

    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lng: Optional[float] = Field(default=None, ge=-180, le=180)
    region: Optional[str] = Field(default=None, min_length=2, max_length=80)
    search_radius_km: float = Field(default=NEARBY_RADIUS_KM, gt=0, le=200)


class CampRequest(BaseModel):
    """Camp details. Location defaults to the blood bank's own."""

    title: str = Field(min_length=3, max_length=150)
    description: Optional[str] = Field(default=None, max_length=1000)
    venue: str = Field(min_length=3, max_length=200)
    start_time: datetime
    end_time: datetime
    capacity: Optional[int] = Field(default=None, ge=1)
    community_service_points: int = Field(default=50, ge=0)
    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lng: Optional[float] = Field(default=None, ge=-180, le=180)
    region: Optional[str] = Field(default=None, min_length=2, max_length=80)

    @field_validator("start_time", "end_time")
    @classmethod
    def _aware(cls, v: datetime) -> datetime:
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)

    @model_validator(mode="after")
    def _times(self) -> "CampRequest":
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


class QRScanRequest(BaseModel):
    bank_id: str
    donor_id: str
    target_id: str = Field(description="camp_id or quest_id")
    target_type: Literal["camp", "quest"]
    blood_bag_id: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9_-]{3,64}$")


class FeedbackRequest(BaseModel):
    target_type: Literal["camp", "quest"]
    target_id: str
    from_role: FeedbackRole
    from_id: str = Field(description="donor id or blood bank id, matching from_role")
    donor_id: Optional[str] = Field(
        default=None, description="Required when the blood bank is the author: the donor the feedback is about"
    )
    rating: int = Field(ge=1, le=5)
    comment: Optional[str] = Field(default=None, max_length=500)


class HospitalRequestAction(BaseModel):
    status: Literal["accepted", "rejected_blood_na", "rejected_service_na"]
    rejection_reason: Optional[str] = Field(default=None, max_length=300)


# ==========================================================================
# Helpers
# ==========================================================================
def _get_bank_or_404(bank_id: str) -> dict:
    snap = db.collection(Collections.BLOOD_BANKS).document(bank_id).get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Blood bank not found")
    return {**snap.to_dict(), "id": snap.id}


def _with_id(snap) -> dict:
    return {**snap.to_dict(), "id": snap.id}


def _notification(donor_id: str, kind: str, title: str, message: str, data: dict) -> dict:
    return {
        "recipient_id": donor_id,
        "recipient_type": "donor",
        "type": kind,
        "title": title,
        "message": message,
        "data": data,
        "is_read": False,
        "created_at": utcnow(),
    }


def _commit_notifications(notifications: list[dict]) -> int:
    """Write notification documents in batches; returns how many were queued."""
    col = db.collection(NOTIFICATIONS)
    for start in range(0, len(notifications), BATCH_LIMIT):
        batch = db.batch()
        for n in notifications[start : start + BATCH_LIMIT]:
            batch.set(col.document(), n)
        batch.commit()
    return len(notifications)


def _notify_nearby_donors(
    donors: list[dict],
    center: tuple[float, float],
    radius_km: float,
    build: Callable[[dict], dict],
) -> int:
    nearby = filter_by_radius(donors, center, radius_km)
    return _commit_notifications([build(d) for d in nearby])


def _phone_variants(phone: str) -> list[str]:
    digits = phone.lstrip("+")
    return sorted({phone, digits, f"+{digits}"})


def _find_matching_donor(phone: str, email: Optional[str]) -> Optional[dict]:
    donors = db.collection(Collections.DONORS)
    hits = donors.where(filter=FieldFilter("phone", "in", _phone_variants(phone))).limit(1).get()
    if not hits and email:
        hits = donors.where(
            filter=FieldFilter("email", "in", sorted({email, email.lower()}))
        ).limit(1).get()
    return _with_id(hits[0]) if hits else None


# ==========================================================================
# 1. Registration
# ==========================================================================
@router.post("/register", status_code=201)
def register_blood_bank(payload: BloodBankCreate) -> dict:
    banks = db.collection(Collections.BLOOD_BANKS)
    if banks.where(filter=FieldFilter("email", "==", payload.email)).limit(1).get():
        raise HTTPException(status_code=409, detail="A blood bank with this email is already registered")

    bank = BloodBank(**payload.model_dump())  # private_donors starts as []
    ref = banks.document()
    ref.set(bank.to_firestore())
    bank.id = ref.id

    return {"message": "Blood bank registered successfully.", "blood_bank": bank.model_dump()}


# ==========================================================================
# 7. Feedback (static path, declared before the /{bank_id}/... routes)
# ==========================================================================
@router.post("/feedback", status_code=201)
def submit_feedback(body: FeedbackRequest) -> dict:
    collection, records_field = TARGETS[body.target_type]
    target_ref = db.collection(collection).document(body.target_id)

    if body.from_role == FeedbackRole.BLOOD_BANK and not body.donor_id:
        raise HTTPException(status_code=400, detail="donor_id is required when the blood bank submits feedback")
    about_donor_id = body.from_id if body.from_role == FeedbackRole.DONOR else body.donor_id

    @firestore.transactional
    def _submit(txn) -> dict:
        snap = target_ref.get(transaction=txn)
        if not snap.exists:
            raise HTTPException(status_code=404, detail=f"{body.target_type.capitalize()} not found")
        target = snap.to_dict()

        if body.from_role == FeedbackRole.BLOOD_BANK and target.get("blood_bank_id") != body.from_id:
            raise HTTPException(status_code=403, detail="This blood bank does not own the target")

        record = next(
            (r for r in target.get(records_field, []) if r.get("donor_id") == about_donor_id), None
        )
        if record is None or record.get("state") != ScanState.COMPLETED.value:
            raise HTTPException(
                status_code=400,
                detail="Feedback is only allowed after the donor's donation scan is completed",
            )

        existing = target.get("feedback", [])
        if any(
            f.get("from_role") == body.from_role.value
            and f.get("from_id") == body.from_id
            and f.get("about_donor_id", f.get("from_id")) == about_donor_id
            for f in existing
        ):
            raise HTTPException(status_code=409, detail="Feedback has already been submitted")

        entry = Feedback(
            from_role=body.from_role, from_id=body.from_id, rating=body.rating, comment=body.comment
        ).to_firestore()
        entry["about_donor_id"] = about_donor_id  # extra key: who the feedback concerns
        txn.update(target_ref, {"feedback": firestore.ArrayUnion([entry])})
        return entry

    entry = _submit(db.transaction())
    return {"message": "Thank you for your feedback.", "feedback": entry}


# ==========================================================================
# 6. Dual-QR scan state machine (static path)
# ==========================================================================
@router.post("/qr-scan")
def qr_scan(body: QRScanRequest) -> dict:
    _get_bank_or_404(body.bank_id)
    collection, records_field = TARGETS[body.target_type]
    target_ref = db.collection(collection).document(body.target_id)
    donor_ref = db.collection(Collections.DONORS).document(body.donor_id)
    bag_ref = db.collection(BLOOD_BAGS).document(body.blood_bag_id) if body.blood_bag_id else None

    @firestore.transactional
    def _scan(txn) -> dict:
        # ---- reads first (Firestore transactions require this) ----
        target_snap = target_ref.get(transaction=txn)
        donor_snap = donor_ref.get(transaction=txn)
        bag_snap = bag_ref.get(transaction=txn) if bag_ref else None

        if not target_snap.exists:
            raise HTTPException(status_code=404, detail=f"{body.target_type.capitalize()} not found")
        if not donor_snap.exists:
            raise HTTPException(status_code=404, detail="Donor not found")

        target = target_snap.to_dict()
        donor = donor_snap.to_dict()
        if target.get("blood_bank_id") != body.bank_id:
            raise HTTPException(
                status_code=404, detail=f"{body.target_type.capitalize()} not found for this blood bank"
            )

        records: list[dict] = list(target.get(records_field, []))
        idx = next((i for i, r in enumerate(records) if r.get("donor_id") == body.donor_id), None)

        # ---- work out the donor's current status ----
        if idx is not None:
            status = records[idx].get("state")
        elif body.target_type == "quest" and body.donor_id in target.get("accepted_donor_ids", []):
            status = "accepted"  # accepted the quest but has no scan record yet
        else:
            raise HTTPException(
                status_code=400,
                detail="Donor is not registered for this camp"
                if body.target_type == "camp"
                else "Donor has not accepted this quest",
            )

        # ---- Scan 1: registered / accepted -> checked_in ----
        if status in (ScanState.REGISTERED.value, "accepted"):
            if idx is not None:
                record = CheckInRecord(**records[idx])
            else:
                record = CheckInRecord(donor_id=body.donor_id, donor_name=donor.get("name"))
            record.scan_in()
            if idx is not None:
                records[idx] = record.to_firestore()
            else:
                records.append(record.to_firestore())
            txn.update(target_ref, {records_field: records})
            return {
                "message": "Scan 1 complete: Donor checked in.",
                "status": record.state,
                "check_in_timestamp": record.checked_in_at,
            }

        # ---- Scan 2: checked_in -> completed ----
        if status == ScanState.CHECKED_IN.value:
            if not body.blood_bag_id:
                raise HTTPException(status_code=400, detail="blood_bag_id is required for Scan 2")
            if bag_snap is not None and bag_snap.exists:
                raise HTTPException(status_code=409, detail="This blood_bag_id has already been recorded")

            multiplier = RARE_POINTS_MULTIPLIER if donor.get("is_rare_shiny") else 1
            base_points = (
                target.get("community_service_points", 0)
                if body.target_type == "camp"
                else QUEST_BASE_POINTS
            )
            record = CheckInRecord(**records[idx])
            points = record.scan_out(
                blood_bag_id=body.blood_bag_id, base_points=base_points, multiplier=multiplier
            )
            records[idx] = record.to_firestore()

            txn.update(target_ref, {records_field: records})
            txn.update(donor_ref, {"total_points": firestore.Increment(points)})
            txn.set(
                bag_ref,
                {
                    "blood_bag_id": body.blood_bag_id,
                    "donor_id": body.donor_id,
                    "donor_blood_group": donor.get("blood_group"),
                    "blood_bank_id": body.bank_id,
                    "target_type": body.target_type,
                    "target_id": body.target_id,
                    "collected_at": record.completed_at,
                },
            )
            return {
                "message": f"Scan 2 complete: Donation recorded. {points} points awarded.",
                "status": record.state,
                "completed_timestamp": record.completed_at,
                "blood_bag_id": body.blood_bag_id,
                "base_points": base_points,
                "points_multiplier": multiplier,
                "points_awarded": points,
                "new_total_points": donor.get("total_points", 0) + points,
            }

        # ---- already completed ----
        raise HTTPException(status_code=409, detail="This donor has already completed the donation scan")

    return _scan(db.transaction())


# ==========================================================================
# 2. Private donors
# ==========================================================================
@router.post("/{bank_id}/private-donors", status_code=201)
def add_private_donor(bank_id: str, body: PrivateDonorRequest) -> dict:
    bank = _get_bank_or_404(bank_id)
    bank_ref = db.collection(Collections.BLOOD_BANKS).document(bank_id)

    match = _find_matching_donor(body.phone, body.email)
    entry = PrivateDonor(
        name=body.name,
        phone=body.phone,
        blood_group=body.blood_group or (match or {}).get("blood_group"),
        is_app_user=match is not None,
        donor_id=match["id"] if match else None,
    )
    variants = set(_phone_variants(body.phone))

    @firestore.transactional
    def _add(txn) -> None:
        snap = bank_ref.get(transaction=txn)
        if not snap.exists:
            raise HTTPException(status_code=404, detail="Blood bank not found")
        if any(p.get("phone") in variants for p in snap.to_dict().get("private_donors", [])):
            raise HTTPException(status_code=409, detail="This donor is already on your private list")
        txn.update(bank_ref, {"private_donors": firestore.ArrayUnion([entry.to_firestore()])})

    _add(db.transaction())

    message = (
        f"{bank['name']} has added you to their private donor list. "
        f"They may contact you when they need your blood group."
    )
    if match:
        notif = _notification(
            match["id"],
            "private_donor_added",
            "Added to a blood bank's donor list",
            message,
            {"blood_bank_id": bank_id, "blood_bank_name": bank["name"]},
        )
        ref = db.collection(NOTIFICATIONS).document()
        ref.set(notif)
        notification = {"channel": "app", "queued": True, "notification_id": ref.id}
    else:
        notification = {"channel": "sms", **send_sms_fallback(body.phone, message)}

    return {
        "message": "Private donor added.",
        "private_donor": entry.model_dump(),
        "notification": notification,
    }


# ==========================================================================
# 3. Emergency quests
# ==========================================================================
@router.post("/{bank_id}/emergency-quests", status_code=201)
def create_emergency_quest(bank_id: str, body: EmergencyQuestRequest) -> dict:
    bank = _get_bank_or_404(bank_id)

    data = body.model_dump()
    data["lat"] = body.lat if body.lat is not None else bank["lat"]
    data["lng"] = body.lng if body.lng is not None else bank["lng"]
    data["region"] = body.region or bank["region"]

    quest = EmergencyQuest(**data, blood_bank_id=bank_id)  # status "open", count 0
    ref = db.collection(Collections.EMERGENCY_QUESTS).document()
    ref.set(quest.to_firestore())
    quest.id = ref.id

    # Eligible donors: compatible blood group, then exact geodesic distance filter.
    groups = DONOR_GROUPS_FOR[quest.blood_group_needed]
    donors = [
        _with_id(s)
        for s in db.collection(Collections.DONORS)
        .where(filter=FieldFilter("blood_group", "in", groups))
        .stream()
    ]

    def build(d: dict) -> dict:
        return _notification(
            d["id"],
            "emergency_quest",
            f"Urgent: {quest.blood_group_needed} blood needed",
            f"{bank['name']} urgently needs {quest.units_required} unit(s) of "
            f"{quest.blood_group_needed} blood, {d['distance_km']} km from you.",
            {
                "quest_id": ref.id,
                "blood_bank_id": bank_id,
                "blood_group_needed": quest.blood_group_needed,
                "distance_km": d["distance_km"],
            },
        )

    nearby = filter_by_radius(donors, (quest.lat, quest.lng), quest.search_radius_km)
    notified = _commit_notifications([build(d) for d in nearby])

    return {
        "message": f"Emergency quest created. {notified} nearby donor(s) notified.",
        "quest": quest.model_dump(),
        "notified_donors_count": notified,
    }


@router.get("/{bank_id}/emergency-quests/{quest_id}")
def track_emergency_quest(bank_id: str, quest_id: str) -> dict:
    _get_bank_or_404(bank_id)
    snap = db.collection(Collections.EMERGENCY_QUESTS).document(quest_id).get()
    if not snap.exists or snap.to_dict().get("blood_bank_id") != bank_id:
        raise HTTPException(status_code=404, detail="Emergency quest not found")
    quest = snap.to_dict()

    accepted_ids = quest.get("accepted_donor_ids", [])
    donors = []
    if accepted_ids:
        refs = [db.collection(Collections.DONORS).document(i) for i in accepted_ids]
        donors = [
            {
                "id": s.id,
                "name": s.to_dict().get("name"),
                "blood_group": s.to_dict().get("blood_group"),
                "profile_image_url": s.to_dict().get("profile_image_url"),
            }
            for s in db.get_all(refs)
            if s.exists
        ]

    feedback = quest.get("feedback", [])
    return {
        "id": snap.id,
        "status": quest.get("status"),
        "criteria_fulfilled": quest.get("status") == RequestStatus.CRITERIA_FULFILLED.value,
        "blood_group_needed": quest.get("blood_group_needed"),
        "units_required": quest.get("units_required"),
        "accepted_donors_count": quest.get("accepted_donors_count", 0),
        "accepted_donors": donors,
        "checkins": quest.get("checkins", []),
        "feedback": {
            "from_blood_bank": [f for f in feedback if f.get("from_role") == FeedbackRole.BLOOD_BANK.value],
            "from_donors": [f for f in feedback if f.get("from_role") == FeedbackRole.DONOR.value],
        },
        "created_at": quest.get("created_at"),
        "fulfilled_at": quest.get("fulfilled_at"),
    }


# ==========================================================================
# 5. Camps
# ==========================================================================
@router.post("/{bank_id}/camps", status_code=201)
def create_camp(bank_id: str, body: CampRequest) -> dict:
    bank = _get_bank_or_404(bank_id)
    if not bank.get("hosts_camps"):
        raise HTTPException(status_code=403, detail="This blood bank is not enabled to host camps")
    if body.end_time <= utcnow():
        raise HTTPException(status_code=400, detail="Camp end_time must be in the future")

    data = body.model_dump()
    data["lat"] = body.lat if body.lat is not None else bank["lat"]
    data["lng"] = body.lng if body.lng is not None else bank["lng"]
    data["region"] = body.region or bank["region"]

    camp = Camp(**data, blood_bank_id=bank_id)  # also generates the qr_token
    ref = db.collection(Collections.CAMPS).document()
    ref.set(camp.to_firestore())
    camp.id = ref.id

    donors = [_with_id(s) for s in db.collection(Collections.DONORS).stream()]

    def build(d: dict) -> dict:
        return _notification(
            d["id"],
            "camp",
            f"Blood donation camp near you: {camp.title}",
            f"{bank['name']} is hosting a camp at {camp.venue}, {d['distance_km']} km from you.",
            {
                "camp_id": ref.id,
                "blood_bank_id": bank_id,
                "start_time": camp.start_time,
                "distance_km": d["distance_km"],
            },
        )

    notified = _notify_nearby_donors(donors, (camp.lat, camp.lng), NEARBY_RADIUS_KM, build)

    return {
        "message": f"Camp created and broadcast to {notified} nearby donor(s).",
        "camp": camp.model_dump(),
        "notified_donors_count": notified,
    }


# ==========================================================================
# 8. Hospital / clinic requests
# ==========================================================================
@router.get("/{bank_id}/hospital-requests")
def list_hospital_requests(
    bank_id: str,
    status: Optional[RequestStatus] = Query(default=None, description="Optional status filter"),
) -> dict:
    bank = _get_bank_or_404(bank_id)
    bank_coords = (bank["lat"], bank["lng"])

    query = db.collection(Collections.HOSPITAL_REQUESTS).where(
        filter=FieldFilter("blood_bank_id", "==", bank_id)
    )
    requests = [_with_id(s) for s in query.stream()]
    if status:
        requests = [r for r in requests if r.get("status") == status.value]

    # Fetch each distinct requestor once.
    requestor_ids = sorted({r["requestor_id"] for r in requests if r.get("requestor_id")})
    requestors = {}
    if requestor_ids:
        refs = [db.collection(Collections.REQUESTORS).document(i) for i in requestor_ids]
        requestors = {s.id: s.to_dict() for s in db.get_all(refs) if s.exists}

    results = []
    for r in requests:
        req = requestors.get(r.get("requestor_id"))
        dist = None
        if req and req.get("lat") is not None and req.get("lng") is not None:
            dist = round(distance_km(bank_coords, (req["lat"], req["lng"])), 2)

        # Prefer a routed estimate from the frontend (OSRM) when one was saved.
        if r.get("estimated_time_min") is not None:
            eta, eta_source = r["estimated_time_min"], "routing"
        elif dist is not None:
            eta, eta_source = round(dist / AVG_CITY_SPEED_KMH * 60, 1), f"fallback_{int(AVG_CITY_SPEED_KMH)}kmh"
        else:
            eta, eta_source = None, None

        results.append(
            {
                **r,
                "distance_km": dist,
                "estimated_time_min": eta,
                "estimate_source": eta_source,
                "requestor": (
                    {
                        "id": r.get("requestor_id"),
                        "facility_name": req.get("facility_name"),
                        "facility_type": req.get("facility_type"),
                        "contact_person": req.get("contact_person"),
                        "phone": req.get("phone"),
                        "address": req.get("address"),
                        "lat": req.get("lat"),
                        "lng": req.get("lng"),
                    }
                    if req
                    else None
                ),
            }
        )

    # Newest first, unknown dates last.
    results.sort(key=lambda x: x.get("created_at") or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return {"count": len(results), "requests": results}


@router.patch("/{bank_id}/hospital-requests/{request_id}")
def respond_to_hospital_request(bank_id: str, request_id: str, body: HospitalRequestAction) -> dict:
    _get_bank_or_404(bank_id)
    ref = db.collection(Collections.HOSPITAL_REQUESTS).document(request_id)

    @firestore.transactional
    def _respond(txn) -> dict:
        snap = ref.get(transaction=txn)
        if not snap.exists or snap.to_dict().get("blood_bank_id") != bank_id:
            raise HTTPException(status_code=404, detail="Hospital request not found")
        if snap.to_dict().get("status") != RequestStatus.OPEN.value:
            raise HTTPException(status_code=409, detail="This request has already been responded to")

        # models.RequestStatus has no "accepted"; CRITERIA_FULFILLED is used for it.
        stored_status = (
            RequestStatus.CRITERIA_FULFILLED.value if body.status == "accepted" else body.status
        )
        updates = {
            "status": stored_status,
            "responded_at": utcnow(),
            "rejection_reason": None if body.status == "accepted" else body.rejection_reason,
        }
        txn.update(ref, updates)
        return {**snap.to_dict(), **updates, "id": snap.id}

    updated = _respond(db.transaction())
    return {
        "message": f"Request marked as {body.status}.",
        "status": body.status,
        "request": updated,
    }
