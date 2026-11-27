"""Riyeser Estimate for the browser test (estimate.e2e.js): a fresh company file, and a stand-in map tile server and
address search on another port, so the test never calls Esri.

    python tests/browser/serve_estimate.py 8091 8092   # app on :8091, tiles and search on :8092
"""
import io
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8091
TILE_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8092
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
work = tempfile.mkdtemp(prefix="riyeser-estimate-e2e-")
os.environ.update(RIYESER_APP_EDITION="estimate", APPDATA=os.path.join(work, "appdata"), RIYESER_HOME=os.path.join(work, "home"),
                  RIYESER_DEMO_FILE=os.path.join(work, "no-demo.json"),
                  RIYESER_MAP_TILES=f"http://127.0.0.1:{TILE_PORT}/tile/{{z}}/{{y}}/{{x}}",
                  RIYESER_MAP_GEOCODE=f"http://127.0.0.1:{TILE_PORT}/geocode")


def _tile():
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (256, 256), (86, 112, 74))
    d = ImageDraw.Draw(im)
    for i in range(0, 256, 32):
        d.line([(i, 0), (i, 255)], fill=(98, 126, 84))
        d.line([(0, i), (255, i)], fill=(98, 126, 84))
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


TILE = _tile()


class Mock(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/tile/"):
            body, ctype = TILE, "image/png"
        elif self.path.startswith("/geocode"):
            body = json.dumps({"candidates": [{"address": "Sample", "location": {"x": 151.0671, "y": -33.8473}, "score": 100}]}).encode()
            ctype = "application/json"
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", TILE_PORT), Mock).serve_forever, daemon=True).start()

from riyeser import create_app  # noqa: E402
from riyeser.db import init_db, get_db  # noqa: E402

app = create_app({"DATABASE": os.path.join(work, "company.db"), "SECRET_KEY": "e2e"})
with app.app_context():
    init_db("Sample Trades Co")
    get_db().execute("UPDATE company SET currency='USD'")
    get_db().commit()
# the sample bathroom plan, for the plan test to open
from riyeser.measure.demo import sample_plan_png  # noqa: E402
with open(os.path.join(work, "plan.png"), "wb") as f:
    f.write(sample_plan_png())
print("PLAN", os.path.join(work, "plan.png"), flush=True)
# sample scans for the Import a scan test: a RoomPlan-style room (GLB) and a raw mesh (OBJ), made by Riyeser
from riyeser.measure.scan import sample  # noqa: E402
with open(os.path.join(work, "bedroom-scan.glb"), "wb") as f:
    f.write(sample.write_glb(sample.room_parts(4.2, 3.6, 2.4)))
with open(os.path.join(work, "mesh-scan.obj"), "wb") as f:
    f.write(sample.write_obj(sample.room_mesh()))
print("SCAN", os.path.join(work, "bedroom-scan.glb"), flush=True)
print("MESH", os.path.join(work, "mesh-scan.obj"), flush=True)
# a site photo for the Photos test (estimate_extras.e2e.js): a wall with a window, drawn here (not a real photo)
def _site_photo():
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (1600, 1200), (196, 186, 170))
    d = ImageDraw.Draw(im)
    for y in range(0, 1200, 60):
        d.line([(0, y), (1600, y)], fill=(184, 172, 156), width=3)
    d.rectangle([520, 260, 1080, 760], fill=(120, 160, 196), outline=(250, 250, 250), width=24)
    d.line([(800, 260), (800, 760)], fill=(250, 250, 250), width=16)
    d.rectangle([0, 1000, 1600, 1200], fill=(110, 92, 70))
    b = io.BytesIO()
    im.save(b, "JPEG", quality=88)
    return b.getvalue()


with open(os.path.join(work, "site-photo.jpg"), "wb") as f:
    f.write(_site_photo())
print("PHOTO", os.path.join(work, "site-photo.jpg"), flush=True)
print("READY", flush=True)
app.run("127.0.0.1", APP_PORT, threaded=True, use_reloader=False)
