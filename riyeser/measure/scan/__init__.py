"""Import a scan: files from room-scanning apps -> rooms in Estimate's room model (riyeser/measure/geometry.py).

What each kind of file gives (see riyeser/templates/estimate/help.html for how to export from each app):

  Full rooms (walls, doors and windows with their sizes)
    Apple RoomPlan USDZ  (and RoomPlan scans saved as GLB, OBJ or DAE that keep its Wall0 / Door0 / Window0 names)
    RoomPlan CapturedRoom / CapturedStructure JSON
  Rooms from a 2D plan (outline, doors and windows; heights are typical sizes to check)
    DXF floor plans (Polycam floor plan DXF, Magicplan DXF, CAD plans)
  Room list (areas, perimeters, heights; no shape)
    CSV (Magicplan statistics export, or any list with Room and Area columns)
  Estimated from a 3D mesh (floor, ceiling and walls found by plane fitting; no doors or windows; check on site)
    Polycam / Canvas / 3D Scanner GLB, glTF, OBJ, DAE, STL, USDZ meshes (and a .zip holding one of them)
  Opened as a plan to measure on
    PDF floor plans (Polycam, Magicplan, Canvas Scan to CAD): their lines aren't sized rooms, so they open in
    "On a plan or photo" to set the scale and draw.
  Not readable
    DWG (closed AutoCAD format: save as DXF), FBX (closed format: export GLB or OBJ), point clouds (PLY, LAS, E57,
    XYZ: no surfaces), IFC, SKP, RVT.

Everything runs on the computer itself, in plain Python: no upload anywhere, no network.
"""
import io
import json
import os
import zipfile

from .meshes import ScanError, read_gltf, read_obj, read_stl, read_dae
from .usd import read_usd
from . import roomplan, planes, plans

MAX_BYTES = 100 * 1024 * 1024
ACCEPT = (".usdz", ".usdc", ".usda", ".usd", ".json", ".glb", ".gltf", ".obj", ".dae", ".stl", ".dxf", ".csv",
          ".pdf", ".zip")
NOT_READABLE = {
    ".dwg": "DWG is AutoCAD's own closed format. Save the plan as DXF (in AutoCAD: Save As > DXF; or the free ODA "
            "File Converter) and import that.",
    ".fbx": "FBX is a closed format. Export the scan as GLB (or OBJ) from the app instead.",
    ".ply": "PLY files from scanning apps are usually point clouds (dots, no surfaces), which can't be measured as "
            "rooms. Export the mesh as GLB or OBJ instead.",
    ".las": "That's a point cloud (dots, no surfaces). Export the scan's mesh as GLB or OBJ instead.",
    ".laz": "That's a point cloud (dots, no surfaces). Export the scan's mesh as GLB or OBJ instead.",
    ".e57": "That's a point cloud (dots, no surfaces). Export the scan's mesh as GLB or OBJ instead.",
    ".xyz": "That's a point cloud (dots, no surfaces). Export the scan's mesh as GLB or OBJ instead.",
    ".pts": "That's a point cloud (dots, no surfaces). Export the scan's mesh as GLB or OBJ instead.",
    ".ifc": "IFC building models can't be read yet. Export the floor plan as DXF, or the 3D model as USDZ or OBJ.",
    ".skp": "SketchUp files can't be read. Export a DXF floor plan, or the model as DAE or OBJ.",
    ".rvt": "Revit files can't be read. Export a DXF floor plan instead.",
    ".svg": "SVG floor plans have no scale Riyeser can trust. Import the DXF or PDF plan instead.",
    ".png": "That's a picture: use 'On a plan or photo' on step 2 to measure on it.",
    ".jpg": "That's a picture: use 'On a plan or photo' on step 2 to measure on it.",
    ".jpeg": "That's a picture: use 'On a plan or photo' on step 2 to measure on it.",
    ".xml": "This XML export can't be read. From Magicplan, export the DXF floor plan or the CSV statistics instead.",
    ".xlsx": "Save the spreadsheet as CSV and import that.",
    ".xls": "Save the spreadsheet as CSV and import that.",
}
QUALITY = {
    "rooms": "Full rooms: walls, doors and windows with their sizes from the scan.",
    "plan": "Rooms from a 2D plan: the outline, doors and windows. Wall, door and window heights are typical sizes: check them.",
    "list": "A room list: areas and perimeters from the app. The rooms' shapes aren't known.",
    "mesh": "Estimated from a 3D mesh: check on site. Floor, ceiling and walls were found in the mesh; doors and windows weren't. Add them by hand.",
}


def kind_of(filename, data):
    ext = os.path.splitext(filename or "")[1].lower()
    if data[:8] == b"PXR-USDC":
        return ".usdc"
    if data[:4] == b"glTF":
        return ".glb"
    if data[:5] == b"%PDF-":
        return ".pdf"
    if data[:2] == b"PK" and ext not in (".usdz",):
        try:
            names = [n.lower() for n in zipfile.ZipFile(io.BytesIO(data)).namelist()]
        except zipfile.BadZipFile:
            names = []
        if any(n.endswith((".usdc", ".usda")) for n in names[:3]):
            return ".usdz"
        return ".zip"
    return ext


def read(filename, data, system="metric", default_height=None):
    """-> {'format', 'quality', 'quality_text', 'rooms', 'notes', 'preview' (bytes or None), 'pdf': bool}.
    Raises ScanError with a plain message for files it can't use."""
    if not data:
        raise ScanError("That file is empty.")
    if len(data) > MAX_BYTES:
        raise ScanError("That file is over 100 MB. Export the scan at a lower detail (in Polycam: Reduced or Medium "
                        "mesh), or as a floor plan (DXF), and try again.")
    h = default_height or (8 * 0.3048 if system == "imperial" else 2.4)
    ext = kind_of(filename, data)
    if ext in NOT_READABLE:
        raise ScanError(NOT_READABLE[ext])
    if ext == ".pdf":
        return {"format": "PDF floor plan", "quality": "pdf", "rooms": [], "notes": [
            "A PDF plan is opened on 'Plan or photo' to set its scale and draw on: its lines aren't sized rooms."],
            "preview": None, "pdf": True, "quality_text": ""}
    if ext == ".zip":
        z = zipfile.ZipFile(io.BytesIO(data))
        inner = [n for n in z.namelist() if os.path.splitext(n)[1].lower() in (".glb", ".gltf", ".obj", ".dae", ".usdz",
                                                                               ".json", ".dxf", ".stl", ".usdc", ".usda")]
        if not inner:
            raise ScanError("That zip has no scan or plan Riyeser can read (GLB, OBJ, DAE, USDZ, DXF or RoomPlan JSON).")
        rank = [".usdz", ".json", ".glb", ".dxf", ".obj", ".dae", ".gltf", ".usdc", ".usda", ".stl"]
        inner.sort(key=lambda n: rank.index(os.path.splitext(n)[1].lower()))
        res = read(inner[0], z.read(inner[0]), system, default_height)
        res["notes"].insert(0, f"Read {os.path.basename(inner[0])} from the zip.")
        return res
    if ext == ".json":
        try:
            js = json.loads(data.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError):
            raise ScanError("That JSON file isn't valid.")
        if not roomplan.looks_like_capturedroom(js):
            raise ScanError("That JSON file isn't a RoomPlan room (it has no walls). Export the scan as USDZ, GLB or "
                            "OBJ, or the floor plan as DXF.")
        return _result("RoomPlan JSON", "rooms", roomplan.from_json(js), [], None)
    if ext == ".dxf":
        rooms, notes = plans.from_dxf(data, default_height=h)
        return _result("DXF floor plan", "plan", rooms, notes, None)
    if ext == ".csv":
        rooms, notes = plans.from_csv(data, system=system, default_height=h)
        return _result("Room list (CSV)", "list", rooms, notes, None)
    readers = {".usdz": read_usd, ".usdc": read_usd, ".usda": read_usd, ".usd": read_usd, ".glb": read_gltf,
               ".gltf": read_gltf, ".obj": read_obj, ".dae": read_dae, ".stl": read_stl}
    if ext not in readers:
        raise ScanError("Riyeser can't read that kind of file. Import a USDZ, GLB, OBJ, DAE, RoomPlan JSON, DXF or "
                        "CSV export (the help page says how to export from each app).")
    scene = readers[ext](data, filename)
    # OBJ and STL don't say which way is up: a plain mesh's is guessed; RoomPlan-style rooms are Y-up like RoomPlan
    scene.normalise(guess_up=ext in (".obj", ".stl") and not roomplan.is_parametric(scene))
    if not scene.parts:
        raise ScanError("That model has no surfaces in it.")
    label = {".usdz": "USDZ", ".usdc": "USDC", ".usda": "USDA", ".usd": "USD", ".glb": "GLB", ".gltf": "glTF",
             ".obj": "OBJ", ".dae": "COLLADA (DAE)", ".stl": "STL"}[ext]
    preview = scene.preview()
    if roomplan.is_parametric(scene):
        rooms = roomplan.from_scene(scene)
        if rooms:
            return _result(f"RoomPlan {label}", "rooms", rooms, scene.notes, preview)
    room, notes = planes.estimate_room(scene)
    if not room:
        raise ScanError(" ".join(notes))
    return _result(f"{label} mesh", "mesh", [room], scene.notes + notes, preview)


def _result(fmt, quality, rooms, notes, preview):
    for r in rooms:
        r["estimated"] = r.get("estimated") or quality == "mesh"
    return {"format": fmt, "quality": quality, "quality_text": QUALITY[quality], "rooms": rooms, "notes": list(notes),
            "preview": preview, "pdf": False}


__all__ = ["read", "ScanError", "MAX_BYTES", "ACCEPT"]
