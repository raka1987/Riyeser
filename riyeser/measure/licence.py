"""The "estimate" licence module: Riyeser Estimate is free for 90 days from its first use, then needs to be on the
business's Riyeser plan (the price after the trial is still to be announced). After the trial without it, everything
is read-only: estimates, measurements, plans and quotes stay to view, print and send; nothing new is measured or
priced. Nothing is ever deleted."""
from .. import licence as L
from .. import plan as P

MODULE = "estimate"
NAME = "Riyeser Estimate"


def status(now=None):
    return L.status(now=now, product=MODULE)


def touch(now=None):
    """Riyeser Estimate is being used: start its 90-day trial on this PC (once)."""
    st = status(now)
    if st.get("mode") == "trial" and "started" in st:   # this PC's first-use trial (started or not): note the use
        L.start_first_use(MODULE, now)
        return status(now)
    return st


def read_only(now=None):
    return status(now).get("mode") == "expired"


def message():
    """The plain message shown when the trial has ended (or the plan doesn't include Estimate)."""
    n = P.locked_notice(MODULE)
    st = status()
    own = f"Your {L.TRIAL_DAYS}-day free trial of {NAME} has ended."
    title = n["title"] if n and (st.get("message") or st.get("source") == "online") else own
    return (f"{title} {NAME} is read-only now: your estimates, measurements and quotes are all still here to view, "
            f"print and send, and nothing has been deleted. To measure and price new work, add {NAME} from your "
            f"Riyeser home page (price to be announced).")


def pill(now=None):
    """{'text', 'cls', 'title'} for the top bar."""
    st = status(now)
    if st.get("mode") == "licensed":
        return None
    if st.get("mode") == "expired":
        return {"text": "Free trial ended · read-only", "cls": "end", "title": message()}
    left = int(st.get("days_left") or L.TRIAL_DAYS)
    return {"text": f"Free trial · {left} day{'' if left == 1 else 's'} left", "cls": "soon" if left <= 14 else "",
            "title": f"{NAME} is free for {L.TRIAL_DAYS} days from when you first use it."}
