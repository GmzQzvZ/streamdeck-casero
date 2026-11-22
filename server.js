import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import OBSWebSocket from 'obs-websocket-js';
import { keyboard, Key } from '@nut-tree-fork/nut-js';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces } from 'os';

const dir = fileURLToPath(new URL('.', import.meta.url));
const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
const buttons = new Map(config.buttons.map((b) => [b.id, b]));

keyboard.config.autoDelayMs = 20;

// ---------- OBS ----------
const obs = new OBSWebSocket();
let obsReady = false;
let retry = null;

function scheduleRetry() {
  obsReady = false;
  if (retry) return;
  retry = setTimeout(() => { retry = null; connectObs(); }, 5000);
}

async function connectObs() {
  try {
    await obs.connect(config.obs.url, config.obs.password || undefined);
    obsReady = true;
    console.log('OBS conectado');
  } catch {
    console.log('OBS no disponible, reintentando en 5 s...');
    scheduleRetry();
  }
}
obs.on('ConnectionClosed', scheduleRetry);

const obsActions = {
  scene: (b) => obs.call('SetCurrentProgramScene', { sceneName: b.value }),
  toggleStream: () => obs.call('ToggleStream'),
  startStream: () => obs.call('StartStream'),
  stopStream: () => obs.call('StopStream'),
  toggleRecord: () => obs.call('ToggleRecord'),
  toggleMute: (b) => obs.call('ToggleInputMute', { inputName: b.value }),
  // Muestra/oculta una fuente dentro de una escena. Si no pones "scene", usa la escena activa.
  toggleSource: async (b) => {
    const sceneName = b.scene || (await obs.call('GetCurrentProgramScene')).currentProgramSceneName;
    const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName, sourceName: b.value });
    const { sceneItemEnabled } = await obs.call('GetSceneItemEnabled', { sceneName, sceneItemId });
    await obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: !sceneItemEnabled });
  },
};

// ---------- Spotify (solo Windows) ----------
// spotify.ps1 queda abierto y manda el comando únicamente a la ventana de Spotify,
// así que no afecta a otros reproductores ni al navegador.
const SPOTIFY = { playpause: 14, next: 11, prev: 12, mute: 8, volup: 10, voldown: 9 };
let sp = null;
const waiting = [];

function startSpotifyHelper() {
  sp = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'spotify.ps1')],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
  );
  let buf = '';
  sp.stdout.setEncoding('utf8');
  sp.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const w = waiting.shift();
      if (w) w(line);
    }
  });
  sp.on('exit', () => {
    sp = null;
    waiting.splice(0).forEach((w) => w('ERROR'));
  });
}

function spotifyCmd(code) {
  if (!sp) startSpotifyHelper();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (sp) sp.kill();
      resolve('TIMEOUT');
    }, 8000);
    waiting.push((line) => { clearTimeout(timer); resolve(line); });
    sp.stdin.write(code + '\n');
  });
}

// ---------- Ejecutar un botón ----------
async function run(b) {
  if (b.type === 'obs') {
    if (!obsReady) throw new Error('OBS no está conectado');
    const fn = obsActions[b.action];
    if (!fn) throw new Error('Acción de OBS desconocida: ' + b.action);
    await fn(b);
  } else if (b.type === 'keys') {
    const keys = b.keys.map((k) => Key[k]);
    const bad = b.keys.find((_, i) => typeof keys[i] !== 'number');
    if (bad !== undefined) throw new Error('Tecla desconocida en config.json: "' + bad + '" (los números se llaman Num1, Num2...)');
    await keyboard.pressKey(...keys);
    await keyboard.releaseKey(...keys);
  } else if (b.type === 'spotify') {
    if (process.platform !== 'win32') throw new Error('El control de Spotify solo funciona en Windows');
    const code = SPOTIFY[b.cmd];
    if (!code) throw new Error('Comando de Spotify desconocido: ' + b.cmd);
    const r = await spotifyCmd(code);
    if (r === 'NOSPOTIFY') throw new Error('No encuentro la ventana de Spotify (¿está abierto?)');
    if (r !== 'OK') throw new Error('No se pudo controlar Spotify');
  } else {
    throw new Error('Tipo de botón desconocido: ' + b.type);
  }
}

// ---------- Servidor web + WebSocket ----------
const app = express();
app.use(express.static(join(dir, 'public')));
app.get('/health', (_req, res) => res.send('ok'));
app.get('/buttons', (_req, res) => {
  res.json(config.buttons.map(({ id, group, label, icon }) => ({ id, group, label, icon })));
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let id;
    try {
      id = JSON.parse(raw).id;
      const b = buttons.get(id);
      if (!b) throw new Error('El botón no existe');
      await run(b);
      ws.send(JSON.stringify({ id, ok: true }));
    } catch (e) {
      ws.send(JSON.stringify({ id, ok: false, error: e.message }));
    }
  });
});

process.on('exit', () => { if (sp) sp.kill(); });

server.listen(config.port, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces()).flat()
    .filter((n) => n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log('Abre esto en el teléfono (misma red WiFi):');
  ips.forEach((ip) => console.log(`  http://${ip}:${config.port}`));
  connectObs();
});
