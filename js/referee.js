// Decides the buzz winner from phone presses. Runs on the main screen and the GM panel;
// the transaction in setWinner guarantees only one decision lands.
export function startReferee(db, A, getGame) {
  let round = null, unsub = null, timer = null;
  const decide = (rows) => {
    const g = getGame();
    if (!g || !g.buzzOpen || g.buzzWinner || g.round !== round) return;
    const valid = rows.filter((r) => r.round === round && (!g.buzzOpenedAt || r.pressedAt >= g.buzzOpenedAt - 150));
    if (!valid.length) return;
    valid.sort((a, b) => a.pressedAt - b.pressedAt);
    const w = valid[0];
    A.setWinner(w.team, "phone").catch((e) => console.warn("referee", e));
  };
  return function onGame(g) {
    if (!g) return;
    if (g.round !== round) {
      round = g.round;
      if (unsub) unsub();
      clearTimeout(timer);
      unsub = db.onColl("buzz", { where: [["round", "==", round]] }, (rows) => {
        if (!rows.length) return;
        clearTimeout(timer);
        timer = setTimeout(() => decide(rows), 300); // collect near-simultaneous presses
      });
    }
  };
}
