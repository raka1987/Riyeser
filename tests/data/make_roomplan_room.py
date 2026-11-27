# How tests/data/roomplan_room.usdc was made (needs Pixar's usd-core: pip install usd-core; not a Riyeser dependency):
#   python tests/data/make_roomplan_room.py tests/data/roomplan_room.usdc
# a RoomPlan-like parametric room in a real USDC (made with Pixar's usd-core), for testing Riyeser's crate reader
import sys, math
from pxr import Usd, UsdGeom, Gf, Sdf, Vt
out = sys.argv[1]
st = Usd.Stage.CreateNew(out)
UsdGeom.SetStageUpAxis(st, UsdGeom.Tokens.y); UsdGeom.SetStageMetersPerUnit(st, 1.0)
root = UsdGeom.Xform.Define(st, "/Room"); st.SetDefaultPrim(root.GetPrim())
for g in ("Parametric_grp", "Parametric_grp/Arch_grp", "Parametric_grp/Arch_grp/Wall_grp", "Parametric_grp/Arch_grp/Door_grp", "Parametric_grp/Arch_grp/Window_grp", "Parametric_grp/Object_grp"):
    UsdGeom.Xform.Define(st, "/Room/" + g)
def box(path, w, h, d, m):
    x = UsdGeom.Xform.Define(st, path); x.AddTransformOp().Set(m)
    mesh = UsdGeom.Mesh.Define(st, path + "/" + path.split("/")[-1])
    pts = [Gf.Vec3f(sx * w / 2, sy * h / 2, sz * d / 2) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    mesh.CreatePointsAttr(pts)
    faces = [[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]]
    mesh.CreateFaceVertexCountsAttr([4]*6); mesh.CreateFaceVertexIndicesAttr([i for f in faces for i in f])
def M(yaw, t):
    r = Gf.Matrix4d().SetRotate(Gf.Rotation(Gf.Vec3d(0, 1, 0), yaw)); r.SetTranslateOnly(Gf.Vec3d(*t)); return r
L, W, H = 4.5, 3.2, 2.6   # room interior; floor at y=-1.3 (RoomPlan puts the origin near the middle)
y0 = -1.3
walls = [(0, (0, y0 + H/2, -W/2), L), (90, (L/2, y0 + H/2, 0), W), (180, (0, y0 + H/2, W/2), L), (270, (-L/2, y0 + H/2, 0), W)]
for i, (yaw, t, ln) in enumerate(walls):
    box(f"/Room/Parametric_grp/Arch_grp/Wall_grp/Wall{i}", ln, H, 0.0001, M(yaw, t))
box("/Room/Parametric_grp/Arch_grp/Door_grp/Door0", 0.82, 2.04, 0.05, M(0, (1.2, y0 + 1.02, -W/2)))
box("/Room/Parametric_grp/Arch_grp/Window_grp/Window0", 1.5, 1.2, 0.05, M(90, (L/2, y0 + 0.9 + 0.6, 0.3)))
box("/Room/Parametric_grp/Object_grp/Table0", 1.2, 0.75, 0.8, M(0, (0, y0 + 0.375, 0)))
st.GetRootLayer().Save()
