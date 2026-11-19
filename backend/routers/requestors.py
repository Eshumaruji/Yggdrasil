"""
Requestor (clinic / hospital) endpoints for Yggdrasil.

Mounted by main.py as:  app.include_router(requestors.router)   (prefix: /requestors)

Design notes
  * Firestore's Python client is synchronous, so every endpoint is a plain `def`
    (FastAPI runs those in a threadpool).
  * Stored documents are built with the real models in models.py. The request
    body uses the friendlier field name `delivery_mode`; it is mapped onto the
    model's `fulfilment_mode` before the HospitalRequest is built.
  * Distance and ETA: the frontend refines these with OSRM and may send them in.
    When it does not, the backend falls back to a straight-line (geodesic)
    distance and a 35 km/h average speed.
  * Hospital requests are sorted in Python, so no composite Firestore index is
    needed.
"""
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from google.cloud.firestore_v1.base_query import FieldFilter

from config import Collections, db
from models import (
    HospitalRequest,
    RequestBase,
    Requestor,
    RequestorCreate,
    RequestStatus,
    utcnow,
)
from utils import distance_km, filter_by_radius

router = APIRouter(prefix="/requestors", tags=["Requestors"])

NEARBY_RADIUS_KM = 25.0
AVG_CITY_SPEED_KMH = 35.0  # backend fallback; the frontend refines this with OSRM

# Fallback keeps this file working if config.Collections lacks the name.
NOTIFICATIONS = getattr(Collections, "NOTIFICATIONS", "notifications")


# ==========================================================================
# Request schemas (local to this router)
# ==========================================================================
class BloodRequestBody(RequestBase):
    """
    Adds the target bank and delivery mode to RequestBase, which already holds
    blood_group_needed, units_required, notes and the optional
    estimated_distance_km / estimated_time_min from the frontend's OSRM router.
    """

    blood_bank_id: str
    delivery_mode: Literal["delivery", "pickup"]


# ==========================================================================
# Helpers
# ==========================================================================
def _get_requestor_or_404(requestor_id: str) -> dict:
    snap = db.collection(Collections.REQUESTORS).document(requestor_id).get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Requestor not found")
    return {**snap.to_dict(), "id": snap.id}


def _with_id(snap) -> dict:
    return {**snap.to_dict(), "id": snap.id}


def _eta_minutes(dist_km: float) -> float:
    """Fallback travel time at the average city speed."""
    return round(dist_km / AVG_CITY_SPEED_KMH * 60, 1)


def _public_blood_bank(bank: dict) -> dict:
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
        "estimated_time_min": _eta_minutes(bank["distance_km"]),
        "estimate_source": f"fallback_{int(AVG_CITY_SPEED_KMH)}kmh",
        # private_donors is deliberately never exposed here.
    }


# ==========================================================================
# 1. Registration
# ==========================================================================
@router.post("/register", status_code=201)
def register_requestor(payload: RequestorCreate) -> dict:
    requestors = db.collection(Collections.REQUESTORS)
    if requestors.where(filter=FieldFilter("email", "==", payload.email)).limit(1).get():
        raise HTTPException(status_code=409, detail="A requestor with this email is already registered")

    requestor = Requestor(**payload.model_dump())
    ref = requestors.document()
    ref.set(requestor.to_firestore())
    requestor.id = ref.id

    return {
        "message": f"{requestor.facility_name} registered successfully.",
        "requestor": requestor.model_dump(),
    }


# ==========================================================================
# 2. Nearby blood banks (for the clinic's map)
# ==========================================================================
@router.get("/{requestor_id}/nearby-blood-banks")
def nearby_blood_banks(requestor_id: str) -> dict:
    requestor = _get_requestor_or_404(requestor_id)
    center = (requestor["lat"], requestor["lng"])

    # Not pre-filtered by region: 25 km can cross city boundaries.
    banks = [_with_id(s) for s in db.collection(Collections.BLOOD_BANKS).stream()]
    nearby = [_public_blood_bank(b) for b in filter_by_radius(banks, center, NEARBY_RADIUS_KM)]

    return {
        "requestor_id": requestor_id,
        "origin": {"lat": requestor["lat"], "lng": requestor["lng"]},
        "radius_km": NEARBY_RADIUS_KM,
        "count": len(nearby),
        "blood_banks": nearby,
    }


# ==========================================================================
# 3. Create a blood request
# ==========================================================================
@router.post("/{requestor_id}/requests", status_code=201)
def create_blood_request(requestor_id: str, body: BloodRequestBody) -> dict:
    requestor = _get_requestor_or_404(requestor_id)

    bank_snap = db.collection(Collections.BLOOD_BANKS).document(body.blood_bank_id).get()
    if not bank_snap.exists:
        raise HTTPException(status_code=404, detail="Blood bank not found")
    bank = bank_snap.to_dict()

    # Straight-line distance, used wherever the frontend did not send OSRM values.
    dist = distance_km((requestor["lat"], requestor["lng"]), (bank["lat"], bank["lng"]))
    est_distance = body.estimated_distance_km if body.estimated_distance_km is not None else round(dist, 2)
    est_time = body.estimated_time_min if body.estimated_time_min is not None else _eta_minutes(dist)

    request = HospitalRequest(
        requestor_id=requestor_id,
        blood_bank_id=body.blood_bank_id,
        fulfilment_mode=body.delivery_mode,
        blood_group_needed=body.blood_group_needed,
        units_required=body.units_required,
        notes=body.notes,
        estimated_distance_km=est_distance,
        estimated_time_min=est_time,
    )

    request_ref = db.collection(Collections.HOSPITAL_REQUESTS).document()
    notification_ref = db.collection(NOTIFICATIONS).document()
    notification = {
        "recipient_id": body.blood_bank_id,
        "recipient_type": "blood_bank",
        "type": "hospital_request",
        "title": f"New blood request from {requestor['facility_name']}",
        "message": (
            f"{requestor['facility_name']} needs {request.units_required} unit(s) of "
            f"{request.blood_group_needed} ({body.delivery_mode}), about {est_distance} km away."
        ),
        "data": {
            "request_id": request_ref.id,
            "requestor_id": requestor_id,
            "blood_group_needed": request.blood_group_needed,
            "units_required": request.units_required,
            "delivery_mode": body.delivery_mode,
            "distance_km": est_distance,
            "estimated_time_min": est_time,
        },
        "is_read": False,
        "created_at": utcnow(),
    }

    # One batch so a request never exists without its notification (or vice versa).
    batch = db.batch()
    batch.set(request_ref, request.to_firestore())
    batch.set(notification_ref, notification)
    batch.commit()
    request.id = request_ref.id

    return {
        "message": f"Your request has been sent to {bank.get('name')}.",
        "request": request.model_dump(),
        "blood_bank_notified": True,
    }


# ==========================================================================
# 4. List this requestor's requests
# ==========================================================================
@router.get("/{requestor_id}/requests")
def list_blood_requests(
    requestor_id: str,
    status: Optional[RequestStatus] = Query(default=None, description="Optional status filter"),
) -> dict:
    requestor = _get_requestor_or_404(requestor_id)
    origin = (requestor["lat"], requestor["lng"])

    query = db.collection(Collections.HOSPITAL_REQUESTS).where(
        filter=FieldFilter("requestor_id", "==", requestor_id)
    )
    requests = [_with_id(s) for s in query.stream()]
    if status:
        requests = [r for r in requests if r.get("status") == status.value]

    # Fetch each distinct blood bank once.
    bank_ids = sorted({r["blood_bank_id"] for r in requests if r.get("blood_bank_id")})
    banks = {}
    if bank_ids:
        refs = [db.collection(Collections.BLOOD_BANKS).document(i) for i in bank_ids]
        banks = {s.id: s.to_dict() for s in db.get_all(refs) if s.exists}

    results = []
    for r in requests:
        bank = banks.get(r.get("blood_bank_id"))

        # Prefer routed values saved at creation time (OSRM); else straight-line.
        dist = r.get("estimated_distance_km")
        if dist is None and bank and bank.get("lat") is not None and bank.get("lng") is not None:
            dist = round(distance_km(origin, (bank["lat"], bank["lng"])), 2)

        if r.get("estimated_time_min") is not None:
            eta, eta_source = r["estimated_time_min"], "routing"
        elif dist is not None:
            eta, eta_source = _eta_minutes(dist), f"fallback_{int(AVG_CITY_SPEED_KMH)}kmh"
        else:
            eta, eta_source = None, None

        results.append(
            {
                **r,
                "delivery_mode": r.get("fulfilment_mode"),
                "accepted": r.get("status") == RequestStatus.CRITERIA_FULFILLED.value,
                "distance_km": dist,
                "estimated_time_min": eta,
                "estimate_source": eta_source,
                "blood_bank": (
                    {
                        "id": r.get("blood_bank_id"),
                        "name": bank.get("name"),
                        "phone": bank.get("phone"),
                        "address": bank.get("address"),
                        "lat": bank.get("lat"),
                        "lng": bank.get("lng"),
                    }
                    if bank
                    else None
                ),
            }
        )

    # Newest first, unknown dates last.
    results.sort(key=lambda x: x.get("created_at") or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return {"count": len(results), "requests": results}
