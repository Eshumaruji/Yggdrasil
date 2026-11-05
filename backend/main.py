"""
Yggdrasil API entry point.

Run from the backend/ folder:
    uvicorn main:app --reload
Docs: http://127.0.0.1:8000/docs
"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import config  # noqa: F401  (initialises Firebase + Cloudinary on import)
from routers import (
    blood_banks,
    # camps,
    # community,
    donors,
    # hospital_requests,
    # quests,
    # requestors,
)

app = FastAPI(
    title="Yggdrasil API",
    description="Community Blood Donor Registry and Emergency Request System",
    version="0.1.0",
)

# Open CORS for development. Credentials stay off because browsers reject
# "*" origins combined with credentials. Restrict origins before production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

for module in (
    donors,
    blood_banks,
    # requestors,
    # quests,
    # hospital_requests,
    # camps,
    # community,
):
    app.include_router(module.router)


@app.get("/", tags=["Health"])
def root() -> dict:
    return {"app": "Yggdrasil", "status": "ok"}
