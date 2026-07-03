import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://avoqogbwrfqjrynujwvr.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_TYJj-r-5T6ri89vyvYjqSw_Wj8Dbkiz";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const EVENTOS_TABLE = "eventos";
const KEY_HOGAR = "roccia_hogar_v1";
const KEY_OUTBOX = "roccia_outbox_v1";
const KEY_LAST_SYNC = "roccia_last_sync_v1";
const KEY_APPLIED_EVENTS = "roccia_applied_events_v1";
const APPLIED_EVENTS_MAX = 200;

export type SyncEventType = "sesion_inicio" | "calibracion" | "sesion_fin" | "reset";

export type SyncEvent = {
  id: string;
  hogar_codigo: string;
  device_id: string;
  tipo: SyncEventType;
  ts_evento: number;
  payload: Record<string, unknown>;
};

export type HogarConfig = {
  codigo: string;
  deviceId: string;
};

function genId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// "ROCCIA-XXXX" sin caracteres ambiguos (0/O, 1/I).
export function generateHogarCodigo(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `ROCCIA-${code}`;
}

export function loadHogar(): HogarConfig | null {
  try {
    const raw = localStorage.getItem(KEY_HOGAR);
    return raw ? (JSON.parse(raw) as HogarConfig) : null;
  } catch {
    return null;
  }
}
function saveHogar(cfg: HogarConfig | null) {
  if (cfg) localStorage.setItem(KEY_HOGAR, JSON.stringify(cfg));
  else localStorage.removeItem(KEY_HOGAR);
}

export function setupHogarNuevo(): HogarConfig {
  const cfg: HogarConfig = { codigo: generateHogarCodigo(), deviceId: genId() };
  saveHogar(cfg);
  return cfg;
}
export function setupHogarExistente(codigo: string): HogarConfig {
  const cfg: HogarConfig = { codigo: codigo.trim().toUpperCase(), deviceId: genId() };
  saveHogar(cfg);
  return cfg;
}

function loadOutbox(): SyncEvent[] {
  try {
    const raw = localStorage.getItem(KEY_OUTBOX);
    return raw ? (JSON.parse(raw) as SyncEvent[]) : [];
  } catch {
    return [];
  }
}
function saveOutbox(events: SyncEvent[]) {
  localStorage.setItem(KEY_OUTBOX, JSON.stringify(events));
}
export function outboxLength(): number {
  return loadOutbox().length;
}

// Se guarda SIEMPRE primero en la cola local; la app nunca espera a la red.
export function enqueueEvent(
  hogar: HogarConfig,
  tipo: SyncEventType,
  payload: Record<string, unknown>,
  tsEvento: number = Date.now()
): SyncEvent {
  const event: SyncEvent = {
    id: genId(),
    hogar_codigo: hogar.codigo,
    device_id: hogar.deviceId,
    tipo,
    ts_evento: tsEvento,
    payload,
  };
  const outbox = loadOutbox();
  outbox.push(event);
  saveOutbox(outbox);
  return event;
}

function loadLastSync(): number {
  const v = Number(localStorage.getItem(KEY_LAST_SYNC));
  return Number.isFinite(v) ? v : 0;
}
function saveLastSync(ts: number) {
  localStorage.setItem(KEY_LAST_SYNC, String(ts));
}
function loadAppliedEventIds(): string[] {
  try {
    const raw = localStorage.getItem(KEY_APPLIED_EVENTS);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function markEventsApplied(ids: string[]) {
  if (ids.length === 0) return;
  const merged = [...ids, ...loadAppliedEventIds()].slice(0, APPLIED_EVENTS_MAX);
  localStorage.setItem(KEY_APPLIED_EVENTS, JSON.stringify(merged));
}

// Intenta subir la cola local, en orden, deteniéndose en el primer fallo
// (red caída): lo ya enviado sale de la cola, el resto se reintenta luego.
async function flushOutbox(): Promise<void> {
  const outbox = loadOutbox();
  let i = 0;
  for (; i < outbox.length; i++) {
    const { error } = await supabase.from(EVENTOS_TABLE).upsert(outbox[i], { onConflict: "id" });
    if (error) {
      // eslint-disable-next-line no-console
      console.error("[sync] fallo al subir evento a Supabase (queda en la cola):", error, outbox[i]);
      break;
    }
  }
  if (i > 0) saveOutbox(outbox.slice(i));
}

// Descarga eventos nuevos del hogar (de otros dispositivos) desde el último
// punto sincronizado, ignorando los propios y los ya aplicados antes.
async function pullRemoteEvents(hogar: HogarConfig): Promise<SyncEvent[]> {
  const since = loadLastSync();
  const { data, error } = await supabase
    .from(EVENTOS_TABLE)
    .select("id,hogar_codigo,device_id,tipo,ts_evento,payload")
    .eq("hogar_codigo", hogar.codigo)
    .gt("ts_evento", since)
    .order("ts_evento", { ascending: true })
    .limit(300);

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[sync] fallo al descargar eventos de Supabase:", error);
    throw error;
  }
  const rows = (data ?? []) as SyncEvent[];

  if (rows.length > 0) {
    saveLastSync(Math.max(since, ...rows.map((e) => e.ts_evento)));
  }

  const appliedIds = new Set(loadAppliedEventIds());
  const fresh = rows.filter((e) => e.device_id !== hogar.deviceId && !appliedIds.has(e.id));
  markEventsApplied(fresh.map((e) => e.id));
  return fresh;
}

export type SyncCycleResult = {
  attempted: boolean; // false si no hay hogar configurado
  reached: boolean; // true si se pudo hablar con el servidor esta vez
  pendingCount: number;
  newRemoteEvents: SyncEvent[];
};

// Punto de entrada del ciclo de sincronización. Nunca lanza: sin internet,
// simplemente no logra nada y lo reporta en el resultado (silencioso).
export async function runSyncCycle(hogar: HogarConfig | null): Promise<SyncCycleResult> {
  if (!hogar) return { attempted: false, reached: false, pendingCount: 0, newRemoteEvents: [] };

  try {
    await flushOutbox();
  } catch (err) {
    // Sin conexión (fetch nunca respondió) o excepción inesperada: no hay UI
    // de error, pero queda registrado en consola para poder diagnosticar.
    // eslint-disable-next-line no-console
    console.error("[sync] flushOutbox lanzó una excepción (sin conexión?):", err);
  }

  try {
    const newRemoteEvents = await pullRemoteEvents(hogar);
    return { attempted: true, reached: true, pendingCount: outboxLength(), newRemoteEvents };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[sync] pullRemoteEvents lanzó una excepción (sin conexión?):", err);
    return { attempted: true, reached: false, pendingCount: outboxLength(), newRemoteEvents: [] };
  }
}

// Suscripción en vivo a inserciones de la tabla "eventos" del hogar, para que
// los cambios del otro teléfono aparezcan en segundos sin esperar el ciclo de 60s.
export function subscribeRealtime(hogar: HogarConfig, onInsert: (event: SyncEvent) => void): () => void {
  const channel = supabase
    .channel(`eventos-${hogar.codigo}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: EVENTOS_TABLE, filter: `hogar_codigo=eq.${hogar.codigo}` },
      (payload: { new: SyncEvent }) => {
        const row = payload.new;
        if (!row || row.device_id === hogar.deviceId) return; // eco de nuestro propio evento
        const appliedIds = new Set(loadAppliedEventIds());
        if (appliedIds.has(row.id)) return;
        markEventsApplied([row.id]);
        saveLastSync(Math.max(loadLastSync(), row.ts_evento));
        onInsert(row);
      }
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
