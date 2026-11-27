"""Turn a Supabase *direct* database URL (db.<ref>.supabase.co, IPv6 only: GitHub's runners can't reach it) into the
Session pooler URL for the same project, which works over IPv4. Uses SUPABASE_ACCESS_TOKEN to ask Supabase for the
pooler's address. Any other URL (already a pooler, or not Supabase) is printed unchanged. Prints only the URL."""
import json, os, re, sys, urllib.parse, urllib.request
url = os.environ.get("DB_URL", "").strip().strip('"').strip("'")
# Read it by hand (not urlsplit): passwords can hold characters a URL parser trips on, and people often leave the
# [ ] from Supabase's "[YOUR-PASSWORD]" around their password.
p = re.fullmatch(r"(postgres(?:ql)?)://([^:/@]+):(.*)@([^@/:]+)(?::(\d+))?(/[^?]*)?(\?.*)?", url)
if not p:
    sys.stderr.write("::error::TEAM_DB_URL doesn't look like a database address. It should start with postgresql:// (Supabase → Connect → Connection String → URI).\n")
    sys.exit(1)
_, user0, pw, host0, port0, path, query = p.groups()
if pw.startswith("[") and pw.endswith("]"):
    pw = pw[1:-1]
if pw.upper() == "YOUR-PASSWORD":
    sys.stderr.write("::error::TEAM_DB_URL still says YOUR-PASSWORD: replace it (and the brackets) with the database password.\n")
    sys.exit(1)
pw = urllib.parse.unquote(pw)
m = re.fullmatch(r"db\.([a-z0-9]+)\.supabase\.co", host0)
if not m:
    print(f"postgresql://{urllib.parse.quote(user0, safe='.')}:{urllib.parse.quote(pw, safe='')}@{host0}:{port0 or 5432}{path or '/postgres'}{query or ''}")
    sys.exit(0)
ref, token = m.group(1), os.environ.get("SUPABASE_ACCESS_TOKEN", "")
if not token:
    sys.stderr.write("::warning::TEAM_DB_URL is Supabase's direct address, which GitHub can't reach, and there's no SUPABASE_ACCESS_TOKEN to look up the pooler. Use the Session pooler line from Supabase → Connect.\n")
    print(url); sys.exit(0)
req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{ref}/config/database/pooler",
                             headers={"Authorization": f"Bearer {token}", "User-Agent": "riyeser-ci/1.0", "Accept": "application/json"})
try:
    cfg = json.load(urllib.request.urlopen(req, timeout=30))
except Exception as e:
    sys.stderr.write(f"::error::Couldn't look up the Session pooler address ({e}). Put the Session pooler line from Supabase → Connect into TEAM_DB_URL instead.\n")
    sys.exit(1)
cfg = cfg if isinstance(cfg, list) else [cfg]
c = next((x for x in cfg if x.get("database_type", "PRIMARY") == "PRIMARY"), cfg[0])
host = c.get("db_host")
if not host:
    sys.stderr.write("::warning::Couldn't find this project's pooler address.\n"); print(url); sys.exit(0)
user = f"postgres.{ref}"
netloc = f"{urllib.parse.quote(user, safe='.')}:{urllib.parse.quote(pw, safe='')}@{host}:5432"
print(f"postgresql://{netloc}{path or '/postgres'}{query or ''}")
sys.stderr.write(f"Using the Session pooler ({host}) instead of the direct address.\n")
