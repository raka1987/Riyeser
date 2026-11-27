"""The demo company for a browser test, as one of the apps (riyeser/edition.py), on its own fresh company file.

    python tests/browser/serve_demo.py 8095 invoices    # basics | plus | invoices | bookings | pos | estimate

One customer gets a long name, so the screens are checked with the kind of text that breaks a layout.
"""
import os
import sys
import tempfile

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8095
EDITION = sys.argv[2] if len(sys.argv) > 2 else "plus"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
work = tempfile.mkdtemp(prefix=f"riyeser-demo-{EDITION}-")
os.environ.update(RIYESER_APP_EDITION=EDITION, APPDATA=os.path.join(work, "appdata"), RIYESER_HOME=os.path.join(work, "home"),
                  RIYESER_DEMO_FILE=os.path.join(work, "no-demo.json"), RIYESER_DOCS=os.path.join(work, "docs"))

from riyeser import create_app  # noqa: E402
from riyeser.db import get_db, init_db  # noqa: E402
from riyeser.demo import seed_demo  # noqa: E402

LONG_NAME = "Northern Rivers Landscaping & Garden Supplies Pty Ltd"

app = create_app({"DATABASE": os.path.join(work, "company.db"), "SECRET_KEY": "browser-test"})
with app.app_context():
    init_db("Sample Trading", edition="basic" if EDITION in ("basic", "basics") else None)
    db = get_db()
    seed_demo(db)
    first = db.execute("SELECT id FROM contacts WHERE kind='customer' ORDER BY id LIMIT 1").fetchone()
    db.execute("UPDATE contacts SET name=? WHERE id=?", (LONG_NAME, first["id"]))
    db.commit()
print(f"Riyeser {EDITION} demo on http://127.0.0.1:{PORT} (admin / admin)", flush=True)
app.run(port=PORT, threaded=True)
