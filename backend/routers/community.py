"""
Community endpoints for Yggdrasil.

Mounted by main.py as:  app.include_router(community.router)   (prefix: /community)

Design notes
  * Firestore's Python client is synchronous, so endpoints are plain `def`
    (FastAPI runs those in a threadpool). The only `async def` is post
    creation, which awaits the Cloudinary upload and wraps its Firestore calls
    in run_in_threadpool.
  * Likes, comments and reports are read-modify-write flows, so they run in
    Firestore transactions: a user can never like or report a post twice, even
    with concurrent requests.
  * The author's display name and picture are looked up server-side from the
    donor / blood bank document, so clients cannot post under a made-up name.
  * Public responses never expose `liked_by` or `reports` (who reported what).
    Pass `user_id` to the feed to get a per-user `liked_by_me` flag instead.
"""
from typing import Literal, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from firebase_admin import firestore
from pydantic import BaseModel, Field, ValidationError

from config import Collections, db
from models import (
    REPORT_HIDE_THRESHOLD,
    CommunityPost,
    CommunityPostCreate,
    Comment,
    ReportFlag,
    utcnow,
)
from utils import upload_image

router = APIRouter(prefix="/community", tags=["Community"])

FEED_LIMIT = 30
REPORT_FLAG_THRESHOLD = 3  # is_flagged is set at this many reports

# config.Collections names this POSTS; COMMUNITY_POSTS is accepted if you rename it.
COMMUNITY_POSTS = getattr(Collections, "COMMUNITY_POSTS", Collections.POSTS)

# author_role -> (collection, field holding the author's picture)
AUTHOR_SOURCES = {
    "donor": (Collections.DONORS, "profile_image_url"),
    "blood_bank": (Collections.BLOOD_BANKS, "logo_url"),
}


# ==========================================================================
# Request schemas (local to this router)
# ==========================================================================
class LikeRequest(BaseModel):
    user_id: str


class CommentRequest(BaseModel):
    author_id: str
    author_name: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=500)


class ReportRequest(BaseModel):
    user_id: str
    reason: str = Field(min_length=3, max_length=300)


# ==========================================================================
# Helpers
# ==========================================================================
def _post_ref(post_id: str):
    return db.collection(COMMUNITY_POSTS).document(post_id)


def _public_post(post: dict, user_id: Optional[str] = None) -> dict:
    """Post as returned to the client (no liker ids, no report details)."""
    return {
        "id": post["id"],
        "author_id": post.get("author_id"),
        "author_name": post.get("author_name"),
        "author_role": post.get("author_role"),
        "author_image_url": post.get("author_image_url"),
        "content": post.get("content"),
        "image_url": post.get("image_url"),
        "likes_count": post.get("likes_count", 0),
        "liked_by_me": bool(user_id) and user_id in post.get("liked_by", []),
        "shares_count": post.get("shares_count", 0),
        "comments_count": len(post.get("comments", [])),
        "comments": post.get("comments", []),
        "is_flagged": post.get("is_flagged", False),
        "created_at": post.get("created_at"),
    }


def _create_post_doc(author_id: str, author_role: str, content: str, image_url: Optional[str]) -> dict:
    """Look up the author, validate with the real model, store, and return the document."""
    collection, image_field = AUTHOR_SOURCES[author_role]
    author_snap = db.collection(collection).document(author_id).get()
    if not author_snap.exists:
        raise HTTPException(status_code=404, detail=f"{author_role.replace('_', ' ').capitalize()} not found")
    author = author_snap.to_dict()

    post = CommunityPost(
        author_id=author_id,
        author_name=author.get("name") or "Unknown",
        content=content,
        image_url=image_url,
    )
    doc = post.to_firestore()
    # Extra fields the CommunityPost model does not define (Firestore is schemaless).
    doc["author_role"] = author_role
    doc["author_image_url"] = author.get(image_field)
    doc["is_flagged"] = False

    ref = db.collection(COMMUNITY_POSTS).document()
    ref.set(doc)
    return {**doc, "id": ref.id}


# ==========================================================================
# 1. Create a post (multipart form, optional image)
# ==========================================================================
@router.post("/posts", status_code=201)
async def create_post(
    author_id: str = Form(...),
    author_role: Literal["donor", "blood_bank"] = Form(...),
    content: str = Form(...),
    image: UploadFile = File(None),
) -> dict:
    # Validate text first so we never upload an image for a post that will be rejected.
    try:
        CommunityPostCreate(author_id=author_id, author_name="-", content=content)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=[e["msg"] for e in exc.errors()])

    # Treat an empty file field (browsers send one when no file is chosen) as "no image".
    image_url = None
    if image is not None and image.filename:
        image_url = await upload_image(image, folder="yggdrasil/community")

    post = await run_in_threadpool(_create_post_doc, author_id, author_role, content, image_url)
    return {"message": "Post published.", "post": _public_post(post, author_id)}


# ==========================================================================
# 2. Feed
# ==========================================================================
@router.get("/posts")
def get_feed(
    user_id: Optional[str] = Query(default=None, description="Adds a liked_by_me flag per post"),
) -> dict:
    snaps = (
        db.collection(COMMUNITY_POSTS)
        .order_by("created_at", direction=firestore.Query.DESCENDING)
        .limit(FEED_LIMIT)
        .stream()
    )
    posts = [{**s.to_dict(), "id": s.id} for s in snaps]

    # Posts that reached the hide threshold are removed from the feed.
    visible = [_public_post(p, user_id) for p in posts if not p.get("is_hidden")]
    return {"count": len(visible), "posts": visible}


# ==========================================================================
# 3. Like / unlike (toggle)
# ==========================================================================
@router.post("/posts/{post_id}/like")
def toggle_like(post_id: str, body: LikeRequest) -> dict:
    ref = _post_ref(post_id)

    @firestore.transactional
    def _toggle(txn) -> dict:
        snap = ref.get(transaction=txn)
        if not snap.exists:
            raise HTTPException(status_code=404, detail="Post not found")
        liked_by = snap.to_dict().get("liked_by", [])

        if body.user_id in liked_by:
            txn.update(ref, {
                "liked_by": firestore.ArrayRemove([body.user_id]),
                "likes_count": len(liked_by) - 1,
            })
            return {"liked": False, "likes_count": len(liked_by) - 1}

        txn.update(ref, {
            "liked_by": firestore.ArrayUnion([body.user_id]),
            "likes_count": len(liked_by) + 1,
        })
        return {"liked": True, "likes_count": len(liked_by) + 1}

    result = _toggle(db.transaction())
    return {"post_id": post_id, "user_id": body.user_id, **result}


# ==========================================================================
# 4. Comment
# ==========================================================================
@router.post("/posts/{post_id}/comments", status_code=201)
def add_comment(post_id: str, body: CommentRequest) -> dict:
    ref = _post_ref(post_id)
    comment = Comment(author_id=body.author_id, author_name=body.author_name, text=body.text)

    @firestore.transactional
    def _add(txn) -> int:
        snap = ref.get(transaction=txn)
        if not snap.exists:
            raise HTTPException(status_code=404, detail="Post not found")
        count = len(snap.to_dict().get("comments", [])) + 1
        txn.update(ref, {"comments": firestore.ArrayUnion([comment.model_dump()])})
        return count

    total = _add(db.transaction())
    return {
        "message": "Comment added.",
        "post_id": post_id,
        "comment": comment.model_dump(),
        "comments_count": total,
    }


# ==========================================================================
# 5. Report
# ==========================================================================
@router.post("/posts/{post_id}/report", status_code=201)
def report_post(post_id: str, body: ReportRequest) -> dict:
    ref = _post_ref(post_id)
    flag = ReportFlag(reported_by=body.user_id, reason=body.reason)

    @firestore.transactional
    def _report(txn) -> dict:
        snap = ref.get(transaction=txn)
        if not snap.exists:
            raise HTTPException(status_code=404, detail="Post not found")
        post = snap.to_dict()

        if post.get("author_id") == body.user_id:
            raise HTTPException(status_code=400, detail="You cannot report your own post")
        reports = post.get("reports", [])
        if any(r.get("reported_by") == body.user_id for r in reports):
            raise HTTPException(status_code=409, detail="You have already reported this post")

        new_count = len(reports) + 1
        updates: dict = {
            "reports": firestore.ArrayUnion([flag.model_dump()]),
            "report_count": new_count,
        }
        flagged = new_count >= REPORT_FLAG_THRESHOLD
        if flagged:
            updates["is_flagged"] = True
        if new_count >= REPORT_HIDE_THRESHOLD:
            updates["is_hidden"] = True
        txn.update(ref, updates)
        return {"report_count": new_count, "is_flagged": flagged or post.get("is_flagged", False)}

    result = _report(db.transaction())
    return {"message": "Thanks, your report has been recorded.", "post_id": post_id, **result}
