"""Riyeser Estimate: photos of the job, with markup (riyeser/measure/photos.py). Opened from the Measure step and the
Send step; the photos ticked "On the quote" go on the quote PDF with their captions."""
import json

from flask import render_template, request, redirect, url_for, flash, abort, jsonify, Response

from ..db import get_db, audit
from ..measure import photos as P
from . import guarded
from .estimate import bp, _t, _units, _touch, _api_error


def photo_view(r):
    return {"id": r["id"], "name": r["name"], "caption": r["caption"] or "", "on_pdf": bool(r["on_pdf"]),
            "width": r["width"], "height": r["height"], "size": r["size"], "marks": len(P.markup_of(r)["shapes"]),
            "v": f"{r['id']}-{len(r['flat'] or b'')}"}


def photos_of(db, tid):
    return [photo_view(r) for r in db.execute("SELECT * FROM takeoff_photos WHERE takeoff_id=? ORDER BY sort, id", (tid,))]


def _photo(tid, pid):
    return get_db().execute("SELECT * FROM takeoff_photos WHERE id=? AND takeoff_id=?", (pid, tid)).fetchone() or abort(404)


@bp.route("/<int:tid>/photos")
def photos(tid):
    db = get_db()
    t = _t(tid)
    cfg = {"tid": tid, "units": _units(t), "readOnly": False, "colours": list(P.COLOURS),
           "maxMB": P.MAX_UPLOAD // (1024 * 1024), "maxPhotos": P.MAX_PHOTOS,
           "urls": {"upload": url_for("estimate.photo_upload", tid=tid), "base": url_for("estimate.photos", tid=tid)}}
    from flask import g
    cfg["readOnly"] = bool(g.get("estimate_read_only"))
    return render_template("estimate/photos.html", t=t, step=3, photos=photos_of(db, tid), cfg=cfg,
                           back=request.args.get("from") or "measure")


@bp.route("/<int:tid>/photos", methods=["POST"])
def photo_upload(tid):
    """One or more photos (multipart "file"). JSON: the photos now, and a message for any that couldn't be added."""
    db = get_db()
    _t(tid)
    files = [f for f in request.files.getlist("file") if f and f.filename]
    if not files:
        return _api_error("Choose a photo (or take one).")
    have = db.execute("SELECT COUNT(*) FROM takeoff_photos WHERE takeoff_id=?", (tid,)).fetchone()[0]
    added, problems = [], []
    for f in files:
        if have + len(added) >= P.MAX_PHOTOS:
            problems.append(f"An estimate keeps up to {P.MAX_PHOTOS} photos: {f.filename} wasn't added.")
            continue
        data = f.read(P.MAX_UPLOAD + 1)
        name = f.filename.replace("\\", "/").rsplit("/", 1)[-1][:120]
        try:
            mime, kept, w, h = P.prepare(data, name)
        except P.PhotoError as e:
            problems.append(str(e))
            continue
        n = db.execute("SELECT COALESCE(MAX(sort),0)+1 FROM takeoff_photos WHERE takeoff_id=?", (tid,)).fetchone()[0]
        added.append(db.execute("INSERT INTO takeoff_photos (takeoff_id, name, mime, size, width, height, data, sort)"
                                " VALUES (?,?,?,?,?,?,?,?)", (tid, name, mime, len(kept), w, h, kept, n)).lastrowid)
    if added:
        _touch(tid)
        audit(db, "estimate_photos_added", f"estimate {tid}: {len(added)}")
        db.commit()
    out = {"ok": bool(added), "added": added, "photos": photos_of(db, tid), "problems": problems}
    if not added:
        out["error"] = " ".join(problems) or "No photo was added."
        return jsonify(out), 413 if any("MB" in p for p in problems) else 400
    return jsonify(out)


@bp.route("/<int:tid>/photos/<int:pid>/img")
def photo_img(tid, pid):
    """The photo: ?v=flat (with its markup, the default), ?v=orig (as taken); ?w=480 for a smaller copy."""
    r = _photo(tid, pid)
    data = r["data"] if request.args.get("v") == "orig" or not r["flat"] else r["flat"]
    mime = r["mime"] if data is r["data"] else "image/jpeg"
    w = request.args.get("w", type=int)
    if w and 40 <= w < max(r["width"] or 0, r["height"] or 0):
        data, mime = P.thumb(data, min(w, 1600)), "image/jpeg"
    return Response(data, mimetype=mime, headers={"Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff"})


@bp.route("/<int:tid>/photos/<int:pid>/markup", methods=["GET", "POST"])
def photo_markup(tid, pid):
    """GET: the markup JSON. POST {markup}: keep it, and make the flattened picture for the PDF."""
    db = get_db()
    _t(tid)
    r = _photo(tid, pid)
    if request.method == "GET":
        return jsonify({"ok": True, "markup": P.markup_of(r), "width": r["width"], "height": r["height"]})
    b = request.get_json(silent=True) or {}
    try:
        m = P.clean_markup(b.get("markup"))
    except P.PhotoError as e:
        return _api_error(str(e))
    flat = P.render(r["data"], m) if m["shapes"] else None
    db.execute("UPDATE takeoff_photos SET markup=?, flat=? WHERE id=?",
               (json.dumps(m) if m["shapes"] else None, flat, pid))
    _touch(tid)
    db.commit()
    row = db.execute("SELECT * FROM takeoff_photos WHERE id=?", (pid,)).fetchone()
    return jsonify({"ok": True, "markup": m, "photo": photo_view(row)})


@bp.route("/<int:tid>/photos/<int:pid>", methods=["POST"])
def photo_save(tid, pid):
    """The caption and "On the quote" (JSON from the Photos screen, or a plain form)."""
    db = get_db()
    _t(tid)
    _photo(tid, pid)
    b = request.get_json(silent=True) if request.is_json else request.form
    b = b or {}
    sets, vals = [], []
    if "caption" in b:
        sets.append("caption=?")
        vals.append((str(b.get("caption") or "")).strip()[:200] or None)
    if "on_pdf" in b:
        v = b.get("on_pdf")
        sets.append("on_pdf=?")
        vals.append(1 if v in (True, 1, "1", "on", "true") else 0)
    if sets:
        db.execute(f"UPDATE takeoff_photos SET {', '.join(sets)} WHERE id=?", vals + [pid])
        _touch(tid)
        db.commit()
    if request.is_json:
        return jsonify({"ok": True, "photo": photo_view(db.execute("SELECT * FROM takeoff_photos WHERE id=?", (pid,)).fetchone())})
    return redirect(request.referrer or url_for("estimate.photos", tid=tid))


@bp.route("/<int:tid>/photos/pdf", methods=["POST"])
@guarded
def photos_on_pdf(tid):
    """The Send step's list: which photos go on the quote PDF."""
    db = get_db()
    _t(tid)
    on = {int(x) for x in request.form.getlist("on") if x.isdigit()}
    for r in db.execute("SELECT id FROM takeoff_photos WHERE takeoff_id=?", (tid,)).fetchall():
        db.execute("UPDATE takeoff_photos SET on_pdf=? WHERE id=?", (1 if r["id"] in on else 0, r["id"]))
    flash("Photos on the quote saved.", "ok")
    return redirect(url_for("estimate.send", tid=tid))


@bp.route("/<int:tid>/photos/<int:pid>/delete", methods=["POST"])
def photo_delete(tid, pid):
    db = get_db()
    _t(tid)
    _photo(tid, pid)
    db.execute("DELETE FROM takeoff_photos WHERE id=? AND takeoff_id=?", (pid, tid))
    _touch(tid)
    db.commit()
    if request.is_json or request.headers.get("X-Requested-With") == "fetch":
        return jsonify({"ok": True, "photos": photos_of(db, tid)})
    flash("Photo removed.", "ok")
    return redirect(url_for("estimate.photos", tid=tid))


__all__ = ["photos_of"]
