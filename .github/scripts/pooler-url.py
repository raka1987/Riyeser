"""Turn a Supabase *direct* database URL (db.<ref>.supabase.co, IPv6 only: GitHub's runners can't reach it) into the
Session pooler URL for the same project, which works over IPv4. Uses SUPABASE_ACCESS_TOKEN to ask Supabase for the
pooler's address. Any other URL (already a pooler, or not Supabase) is printed unchanged. Prints only the URL."""
import json, os, re, sys, urllib.parse, urllib.request
url = os.environ.get("DB_URL", "").strip()
u = urllib.parse.urlsplit(url)
m = re.fullmatch(r"db\.([a-z0-9]+)\.supabase\.co", u.hostname or "")
if not m:
    print(url); sys.exit(0)
ref, token = m.group(1), os.environ.get("SUPABASE_ACCESS_TOKEN", "")
if not token:
    sys.stderr.write("::warning::TEAM_DB_URL is Supabase's direct address, which GitHub can't reach, and there's no SUPABASE_ACCESS_TOKEN to look up the pooler. Use the Session pooler line from Supabase → Connect.\n")
    print(url); sys.exit(0)
req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{ref}/config/database/pooler",
                             headers={"Authorization": f"Bearer {token}"})
cfg = json.load(urllib.request.urlopen(req, timeout=30))
cfg = cfg if isinstance(cfg, list) else [cfg]
c = next((x for x in cfg if x.get("database_type", "PRIMARY") == "PRIMARY"), cfg[0])
host = c.get("db_host")
if not host:
    sys.stderr.write("::warning::Couldn't find this project's pooler address.\n"); print(url); sys.exit(0)
pw = urllib.parse.unquote(u.password or "")
user = f"postgres.{ref}"
netloc = f"{urllib.parse.quote(user, safe='.')}:{urllib.parse.quote(pw, safe='')}@{host}:5432"
print(urllib.parse.urlunsplit(("postgresql", netloc, u.path or "/postgres", u.query, "")))
sys.stderr.write(f"Using the Session pooler ({host}) instead of the direct address.\n")
