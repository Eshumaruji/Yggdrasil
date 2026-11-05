"""
Central configuration for Yggdrasil.

Importing this module:
  * loads variables from backend/.env
  * initialises Firebase Admin (Firestore) using serviceAccountKey.json
  * configures the Cloudinary SDK

Other modules should do:  from config import db, Collections
"""
import logging
import os
from pathlib import Path

import cloudinary
import firebase_admin
from dotenv import load_dotenv
from firebase_admin import credentials, firestore

logger = logging.getLogger("yggdrasil.config")

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

# --------------------------------------------------------------------------
# Firebase / Firestore
# --------------------------------------------------------------------------
FIREBASE_CREDENTIALS_PATH = Path(
    os.getenv("FIREBASE_CREDENTIALS_PATH", BASE_DIR / "serviceAccountKey.json")
)


def init_firebase() -> firestore.Client:
    """Initialise Firebase Admin once and return a Firestore client."""
    try:
        firebase_admin.get_app()  # already initialised (e.g. uvicorn --reload)
    except ValueError:
        if not FIREBASE_CREDENTIALS_PATH.exists():
            raise FileNotFoundError(
                f"Firebase service account key not found at "
                f"'{FIREBASE_CREDENTIALS_PATH}'. Download it from Firebase "
                f"Console > Project settings > Service accounts."
            )
        cred = credentials.Certificate(str(FIREBASE_CREDENTIALS_PATH))
        firebase_admin.initialize_app(cred)
    return firestore.client()


db: firestore.Client = init_firebase()


class Collections:
    """Firestore collection names, kept in one place to avoid typos."""

    DONORS = "donors"
    BLOOD_BANKS = "blood_banks"
    REQUESTORS = "requestors"
    EMERGENCY_QUESTS = "emergency_quests"
    HOSPITAL_REQUESTS = "hospital_requests"
    CAMPS = "camps"
    POSTS = "community_posts"


# --------------------------------------------------------------------------
# Cloudinary (images are stored there; only the secure_url goes in Firestore)
# --------------------------------------------------------------------------
cloudinary.config(
    cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
    api_key=os.getenv("CLOUDINARY_API_KEY"),
    api_secret=os.getenv("CLOUDINARY_API_SECRET"),
    secure=True,
)

if not all(
    os.getenv(k)
    for k in ("CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET")
):
    logger.warning("Cloudinary credentials missing: image uploads will fail.")

# --------------------------------------------------------------------------
# App-wide defaults
# --------------------------------------------------------------------------
DEFAULT_SEARCH_RADIUS_KM = 10.0
