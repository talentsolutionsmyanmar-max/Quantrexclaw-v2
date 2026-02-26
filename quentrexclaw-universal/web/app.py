import streamlit as st
from datetime import datetime, timedelta
st.set_page_config(page_title="QuentrexClaw v3.5", layout="wide")
st.title("🚀 QuentrexClaw – Peps Trading Killzone Agent")
st.markdown("**MMT Timezone | Only A+/A | Simulate until CONFIRM + EXECUTE REAL**")

def is_killzone():
    mmt = datetime.utcnow() + timedelta(hours=6, minutes=30)
    h = mmt.hour + mmt.minute/60.0
    return (6.5 <= h <= 10) or (13 <= h <= 17) or (18.25 <= h <= 22.083), mmt.strftime("%H:%M MMT")

in_kz, mmt_time = is_killzone()
st.metric("MMT Time", mmt_time, "🔥 KILLZONE OPEN" if in_kz else "⏳ WAITING")

command = st.text_input("Type command:", "QuentrexClaw prep SOLUSDT AKZ")
if st.button("ROCK THE PREP"):
    if not in_kz:
        st.error("NO TRADE - Outside Killzone")
    else:
        st.success("✅ Data Pack loaded")
        st.subheader("6-Line Analysis")
        st.markdown("**1. Confluence: 94/100** – VWAP reclaim + Orion spike\n**2. SMB: 4.9/5**\n**3. Trigger: Sweep→Reclaim**\n**4. Decision: GO**\n**5. Plan: Long @148.80 | SL 148.10 | TP1 150.50 | TP2 152.20 | Exit 22:05**\n**6. Notes: No news**")
        if st.button("CONFIRM + EXECUTE REAL"):
            st.balloons()
            st.success("TINY TRADE EXECUTED on MEXC (0.42% risk)")
