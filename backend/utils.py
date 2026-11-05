"""
Shared helpers: Cloudinary image upload and geopy distance calculations.
"""
import io
from typing import Iterable

import cloudinary.exceptions
import cloudinary.uploader
from fastapi import HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from geopy.distance import geodesic

import config  # noqa: F401  (ensures Cloudinary is configured)

# ==========================================================================
# Image upload (Cloudinary)
# ==========================================================================
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MB


async def upload_image(file: UploadFile, folder: str = "yggdrasil/misc") -> str:
    """
    Validate an uploaded image, send it to Cloudinary and return its secure_url.
    Only this URL string is stored in Firestore.

    Example endpoint (added in the next step):

        @router.post("/{donor_id}/profile-image")
        async def set_profile_image(donor_id: str, file: UploadFile = File(...)):
            url = await upload_image(file, folder="yggdrasil/profiles")
            db.collection(Collections.DONORS).document(donor_id).update(
                {"profile_image_url": url}
            )
            return {"profile_image_url": url}
    """
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="Only JPEG, PNG or WebP images are allowed")

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(contents) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image must be 5 MB or smaller")

    try:
        # The Cloudinary SDK is synchronous, so run it off the event loop.
        result = await run_in_threadpool(
            cloudinary.uploader.upload,
            io.BytesIO(contents),
            folder=folder,
            resource_type="image",
        )
    except cloudinary.exceptions.Error as exc:
        raise HTTPException(status_code=502, detail=f"Image upload failed: {exc}")

    return result["secure_url"]


# ==========================================================================
# Geolocation (geopy)
# ==========================================================================
LatLng = tuple[float, float]


def distance_km(a: LatLng, b: LatLng) -> float:
    """Geodesic distance in kilometres between two (lat, lng) points."""
    return geodesic(a, b).kilometers


def filter_by_radius(
    docs: Iterable[dict],
    center: LatLng,
    radius_km: float,
    *,
    lat_key: str = "lat",
    lng_key: str = "lng",
) -> list[dict]:
    """
    Keep documents within `radius_km` of `center`, add a `distance_km` field
    and sort nearest first.

    Typical use: pre-filter in Firestore by region and blood group (cheap),
    then run the exact distance check here.

        snaps = (
            db.collection(Collections.DONORS)
            .where("region", "==", region)
            .where("blood_group", "==", blood_group)
            .stream()
        )
        donors = [{**s.to_dict(), "id": s.id} for s in snaps]
        nearby = filter_by_radius(donors, (lat, lng), radius_km=10)
    """
    results = []
    for doc in docs:
        if doc.get(lat_key) is None or doc.get(lng_key) is None:
            continue
        dist = distance_km(center, (doc[lat_key], doc[lng_key]))
        if dist <= radius_km:
            results.append({**doc, "distance_km": round(dist, 2)})
    return sorted(results, key=lambda d: d["distance_km"])
