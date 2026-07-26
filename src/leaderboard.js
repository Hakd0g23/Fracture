// Supabase REST client for the online leaderboard. DOM-free (same layering
// convention as core.js) -- main.js owns all UI wiring. Every call is
// wrapped so a network failure or missing config never crashes the game;
// offline play must keep working.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

function headers() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };
}

function configured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export async function fetchTopScores(limit = 10) {
  if (!configured()) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/scores?select=name,score&order=score.desc&limit=${limit}`,
      { headers: headers() },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function submitScore(name, score) {
  if (!configured()) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/scores`, {
      method: 'POST',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify({ name, score }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
