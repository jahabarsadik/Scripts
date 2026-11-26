import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { cbgmApi as api } from '../api/client';

/*
 * How many CBGM requests wait for the signed-in user on My Approval (GET /api/cbgm/my-approvals/count), for the number
 * on the My Approval menu items (left menu and the user menu, top right). One shared count for the whole page: read
 * when the page opens, after a page change (at most every 15 s), every minute, and straight after My Approval submits
 * (refreshPendingApprovals()). 0 while unknown or when the count cannot be read.
 */
let count = 0;
let lastRead = 0;
let request = null;
const listeners = new Set();
let timer = null; // one timer for the page, while any menu shows the number

function read(force) {
  if (request || (!force && Date.now() - lastRead < 15000)) return;
  lastRead = Date.now();
  request = api.get('/my-approvals/count')
    .then((d) => { count = Number(d && d.total) || 0; })
    .catch(() => {}) // keep the last number
    .finally(() => { request = null; listeners.forEach((l) => l(count)); });
}

/** Read the count again now (e.g. after approving or rejecting) */
export function refreshPendingApprovals() {
  read(true);
}

/** enabled: false = no CBGM access (nothing is read, 0) */
export default function usePendingApprovals(enabled = true) {
  const [n, setN] = useState(count);
  const { pathname } = useLocation();
  useEffect(() => {
    if (!enabled) return undefined;
    listeners.add(setN);
    setN(count);
    if (!timer) timer = setInterval(() => read(true), 60000);
    return () => {
      listeners.delete(setN);
      if (!listeners.size) { clearInterval(timer); timer = null; count = 0; lastRead = 0; } // e.g. log out: next user starts fresh
    };
  }, [enabled]);
  useEffect(() => { if (enabled) read(false); }, [enabled, pathname]);
  return enabled ? n : 0;
}
