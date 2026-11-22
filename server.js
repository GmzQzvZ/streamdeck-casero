import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import OBSWebSocket from 'obs-websocket-js';
import { keyboard, Key } from '@nut-tree-fork/nut-js';
import { execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import QRCode from 'qrcode';
import { readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { networkInterfaces } from 'os';

const dir = fileURLToPath(new URL('.', import.meta.url));
const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
const tablerIconDir = join(dir, 'node_modules', '@tabler', 'icons', 'icons', 'outline');
const tablerIcons = new Set(readdirSync(tablerIconDir)
  .filter((name) => name.endsWith('.svg'))
  .map((name) => name.slice(0, -4)));
let buttons = new Map(config.buttons.map((b) => [b.id, b]));
const integrations = {
  spotify: typeof config.integrations?.spotify === 'boolean'
    ? config.integrations.spotify
    : config.buttons.some((button) => button.type === 'spotify'),
  voicemeeter: typeof config.integrations?.voicemeeter === 'boolean'
    ? config.integrations.voicemeeter
    : config.buttons.some((button) => button.type === 'voicemeeter')
};
let configuredAppIds = new Set(config.buttons.filter((button) => button.type === 'application').map((button) => button.appId));
let applicationDiscoveryError = null;
const installedApplications = discoverInstalledApplications();

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
const OBS_ACTIONS = new Set(['scene', 'toggleStream', 'startStream', 'stopStream', 'toggleRecord', 'toggleMute', 'toggleSource']);
const SPOTIFY_COMMANDS = new Set(Object.keys(SPOTIFY));
let sp = null;
const waiting = [];

function invalidEditorInput(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function discoverInstalledApplications() {
  if (process.platform !== 'win32') {
    applicationDiscoveryError = 'El selector de aplicaciones instaladas solo está disponible en Windows';
    return new Map();
  }
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'installed-applications.ps1')],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 }
    );
    const entries = JSON.parse(output);
    if (!Array.isArray(entries)) throw new Error('La lista de aplicaciones no tiene un formato válido');
    const applications = new Map();
    entries.forEach((entry) => {
      if (!entry || typeof entry.name !== 'string' || typeof entry.path !== 'string' ||
          !/^[a-zA-Z]:\\.*\.exe$/i.test(entry.path)) return;
      const id = createHash('sha256').update(entry.path.toLowerCase()).digest('hex').slice(0, 24);
      if (!applications.has(id)) applications.set(id, { id, name: entry.name.slice(0, 80), path: entry.path });
    });
    return applications;
  } catch (error) {
    applicationDiscoveryError = 'No se pudieron detectar las aplicaciones del Menú Inicio: ' + error.message;
    console.error(applicationDiscoveryError);
    return new Map();
  }
}

function validateEditorButtons(value) {
  if (!Array.isArray(value) || value.length > 100) {
    invalidEditorInput('La botonera debe tener entre 0 y 100 botones');
  }

  const ids = new Set();
  return value.map((button) => {
    if (!button || typeof button !== 'object') invalidEditorInput('Definición de botón inválida');
    const id = String(button.id || '');
    const label = String(button.label || '').trim();
    const group = String(button.group || '').trim();
    const icon = String(button.icon || '');
    const iconType = button.iconType || 'emoji';
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(id) || ids.has(id)) invalidEditorInput('ID de botón inválido o repetido');
    if (!label || label.length > 32) invalidEditorInput('El nombre debe tener entre 1 y 32 caracteres');
    if (!group || group.length > 24 || group.toLowerCase() === 'all') invalidEditorInput('Perfil inválido');
    if (iconType === 'tabler' ? !tablerIcons.has(icon) : iconType !== 'emoji' || icon.length > 12) {
      invalidEditorInput('Selecciona un icono válido');
    }
    ids.add(id);

    const result = { id, label, group, icon, iconType };
    for (const field of ['accent', 'background']) {
      if (button[field] !== undefined && button[field] !== '') {
        if (typeof button[field] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(button[field])) {
          invalidEditorInput('Color inválido');
        }
        result[field] = button[field];
      }
    }
    if (button.image) {
      if (typeof button.image !== 'string' || button.image.length > 700000 ||
          !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(button.image)) {
        invalidEditorInput('La imagen debe ser PNG, JPG o WebP y pesar menos de 500 KB');
      }
      result.image = button.image;
    }

    if (button.type === 'obs') {
      if (!OBS_ACTIONS.has(button.action)) invalidEditorInput('Acción de OBS no válida');
      result.type = 'obs';
      result.action = button.action;
      if (['scene', 'toggleMute', 'toggleSource'].includes(button.action)) {
        if (typeof button.value !== 'string' || !button.value.trim() || button.value.length > 120) {
          invalidEditorInput('Falta el nombre de escena, fuente o entrada de OBS');
        }
        result.value = button.value.trim();
      }
      if (button.action === 'toggleSource' && typeof button.scene === 'string' && button.scene.trim()) {
        result.scene = button.scene.trim().slice(0, 120);
      }
    } else if (button.type === 'keys') {
      if (!Array.isArray(button.keys) || button.keys.length < 1 || button.keys.length > 4 ||
          button.keys.some((key) => typeof key !== 'string' || typeof Key[key] !== 'number')) {
        invalidEditorInput('Atajo de teclado inválido; revisa los nombres de tecla');
      }
      result.type = 'keys';
      result.keys = button.keys;
    } else if (button.type === 'spotify') {
      if (!SPOTIFY_COMMANDS.has(button.cmd)) invalidEditorInput('Comando de Spotify no válido');
      result.type = 'spotify';
      result.cmd = button.cmd;
    } else if (button.type === 'application') {
      const appId = String(button.appId || '');
      if (!/^[a-f0-9]{24}$/.test(appId) ||
          (!installedApplications.has(appId) && !configuredAppIds.has(appId))) {
        invalidEditorInput('Selecciona una aplicación instalada en este computador');
      }
      result.type = 'application';
      result.appId = appId;
    } else if (button.type === 'voicemeeter') {
      if (!/^(Strip|Bus)\[[0-4]\]\.(Mute|Gain)$/.test(button.param || '')) {
        invalidEditorInput('Parámetro de Voicemeeter no válido');
      }
      if (button.action === 'toggleMute' && button.param.endsWith('.Mute')) {
        result.action = button.action;
      } else if (button.action === 'changeGain' && button.param.endsWith('.Gain') &&
                 Number.isFinite(button.delta) && Math.abs(button.delta) <= 12 && button.delta !== 0) {
        result.action = button.action;
        result.delta = button.delta;
      } else if (button.action === 'changeVolumePercent' && button.param.endsWith('.Gain') &&
                 Number.isInteger(button.delta) && Math.abs(button.delta) <= 100 && button.delta !== 0) {
        result.action = button.action;
        result.delta = button.delta;
      } else {
        invalidEditorInput('Acción de Voicemeeter no válida');
      }
      result.type = 'voicemeeter';
      result.param = button.param;
    } else {
      invalidEditorInput('Tipo de botón no válido');
    }
    return result;
  });
}

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

// ---------- Voicemeeter Remote API ----------
let vm = null;
let vmBuffer = '';
let vmError = '';
const vmWaiting = [];

function startVoicemeeterHelper() {
  vm = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'voicemeeter.ps1')],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  vmBuffer = '';
  vmError = '';
  vm.stdout.setEncoding('utf8');
  vm.stderr.setEncoding('utf8');
  vm.stdout.on('data', (data) => {
    vmBuffer += data;
    let end;
    while ((end = vmBuffer.indexOf('\n')) >= 0) {
      const line = vmBuffer.slice(0, end).trim();
      vmBuffer = vmBuffer.slice(end + 1);
      if (!line) continue;
      const pending = vmWaiting.shift();
      if (!pending) continue;
      clearTimeout(pending.timer);
      try {
        const result = JSON.parse(line);
        if (!result.ok) pending.reject(new Error(result.error));
        else pending.resolve(result.value);
      } catch (error) {
        pending.reject(error);
      }
    }
  });
  vm.stderr.on('data', (data) => { vmError += data; });
  vm.on('error', (error) => {
    vm = null;
    vmWaiting.splice(0).forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
  });
  vm.on('exit', () => {
    vm = null;
    const error = new Error(vmError.trim() || 'Voicemeeter Remote API se desconectó');
    vmWaiting.splice(0).forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
  });
}

function voicemeeterCmd(command) {
  if (process.platform !== 'win32') throw new Error('Voicemeeter solo se puede controlar en Windows');
  if (!vm) startVoicemeeterHelper();
  return new Promise((resolve, reject) => {
    const pending = {
      resolve,
      reject,
      timer: setTimeout(() => {
        if (vm) vm.kill();
        reject(new Error('Tiempo de espera agotado al comunicarse con Voicemeeter'));
      }, 5000)
    };
    vmWaiting.push(pending);
    vm.stdin.write(JSON.stringify(command) + '\n', (error) => {
      if (!error) return;
      clearTimeout(pending.timer);
      const index = vmWaiting.indexOf(pending);
      if (index >= 0) vmWaiting.splice(index, 1);
      reject(error);
    });
  });
}

// ---------- Ejecutar un botón ----------
function isButtonEnabled(button) {
  if (button.type === 'spotify') return integrations.spotify;
  if (button.type === 'voicemeeter') return integrations.voicemeeter;
  return true;
}

function launchApplication(appId) {
  const application = installedApplications.get(appId);
  if (!application) throw new Error('La aplicación ya no está disponible; selecciónala de nuevo en el editor');
  return new Promise((resolve, reject) => {
    const child = spawn(application.path, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function isLocalIPv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets;
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    (first === 100 && second >= 64 && second <= 127);
}

async function run(b) {
  if (b.type === 'voicemeeter') {
    if (!integrations.voicemeeter) throw new Error('La integración de Voicemeeter está desactivada');
    await voicemeeterCmd({ action: b.action, param: b.param, delta: b.delta });
  } else if (b.type === 'obs') {
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
    if (!integrations.spotify) throw new Error('La integración de Spotify está desactivada');
    if (process.platform !== 'win32') throw new Error('El control de Spotify solo funciona en Windows');
    const code = SPOTIFY[b.cmd];
    if (!code) throw new Error('Comando de Spotify desconocido: ' + b.cmd);
    const r = await spotifyCmd(code);
    if (r === 'NOSPOTIFY') throw new Error('No encuentro la ventana de Spotify (¿está abierto?)');
    if (r !== 'OK') throw new Error('No se pudo controlar Spotify');
  } else if (b.type === 'application') {
    await launchApplication(b.appId);
  } else {
    throw new Error('Tipo de botón desconocido: ' + b.type);
  }
}

// ---------- Servidor web + WebSocket ----------
const app = express();
app.use(express.json({ limit: '6mb' }));
app.use(express.static(join(dir, 'public')));
app.get('/health', (_req, res) => res.send('ok'));
app.get('/connect-info', async (_req, res) => {
  try {
    const addresses = Object.entries(networkInterfaces()).flatMap(([interfaceName, entries]) =>
      entries
        .filter((entry) => entry.family === 'IPv4' && !entry.internal && isLocalIPv4(entry.address))
        .map((entry) => ({ interfaceName, address: entry.address }))
    );
    const connections = await Promise.all(addresses.map(async ({ interfaceName, address }) => {
      const url = `http://${address}:${config.port}`;
      const qr = await QRCode.toDataURL(url, { width: 220, margin: 2 });
      return { interfaceName, url, qr };
    }));
    res.json(connections);
  } catch (error) {
    console.error('No se pudieron generar códigos QR:', error.message);
    res.status(500).json({ error: 'No se pudieron generar los códigos QR' });
  }
});
app.get('/buttons', (_req, res) => {
  res.json(config.buttons.filter(isButtonEnabled).map(({ id, group, label, icon, iconType, accent, background, image }) => ({
    id, group, label, icon, iconType, accent, background, image
  })));
});
app.get('/editor', (_req, res) => {
  const columns = config.columns || 0;
  const rows = config.rows || (columns ? Math.ceil(config.buttons.length / columns) : 0);
  res.json({ buttons: config.buttons, rows, columns, integrations });
});
app.get('/installed-applications', (_req, res) => {
  if (applicationDiscoveryError) {
    return res.status(503).json({ error: applicationDiscoveryError });
  }
  res.json(Array.from(installedApplications.values(), ({ id, name }) => ({ id, name })));
});
app.get('/editor-icons', (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
  const favorites = ['microphone', 'volume', 'device-desktop', 'headphones', 'music', 'camera', 'player-play', 'player-pause', 'device-tv', 'brand-discord', 'brand-spotify'];
  const matches = (name) => !query || name.includes(query);
  const results = favorites.filter((name) => tablerIcons.has(name) && matches(name));
  for (const name of tablerIcons) {
    if (results.length >= 100) break;
    if (matches(name) && !results.includes(name)) results.push(name);
  }
  res.json(results);
});
app.get('/tabler-icons/:icon', (req, res) => {
  const icon = req.params.icon;
  if (!tablerIcons.has(icon)) return res.sendStatus(404);
  res.type('image/svg+xml').sendFile(join(tablerIconDir, icon + '.svg'));
});
app.put('/editor', (req, res) => {
  try {
    const updatedButtons = validateEditorButtons(req.body && req.body.buttons);
    const rows = req.body && req.body.rows;
    const columns = req.body && req.body.columns;
    const requestedIntegrations = req.body && req.body.integrations;
    let updatedIntegrations = { ...integrations };
    if (requestedIntegrations !== undefined) {
      if (!requestedIntegrations || typeof requestedIntegrations !== 'object' ||
          typeof requestedIntegrations.spotify !== 'boolean' ||
          typeof requestedIntegrations.voicemeeter !== 'boolean') {
        invalidEditorInput('La configuración de integraciones no es válida');
      }
      updatedIntegrations = {
        spotify: requestedIntegrations.spotify,
        voicemeeter: requestedIntegrations.voicemeeter
      };
    }
    if (!Number.isInteger(rows) || rows < 0 || rows > 12 ||
        !Number.isInteger(columns) || columns < 0 || columns > 12 ||
        ((rows === 0) !== (columns === 0))) {
      invalidEditorInput('Filas y columnas deben ser ambas automáticas (0) o estar entre 1 y 12');
    }
    if (rows * columns < updatedButtons.length) {
      invalidEditorInput('La cuadrícula no tiene espacio para todos los botones');
    }

    const updatedConfig = { ...config, buttons: updatedButtons, rows, columns, integrations: updatedIntegrations };
    const configPath = join(dir, 'config.json');
    const tempPath = configPath + '.' + process.pid + '.tmp';
    writeFileSync(tempPath, JSON.stringify(updatedConfig, null, 2) + '\n', 'utf8');
    renameSync(tempPath, configPath);

    config.buttons = updatedButtons;
    config.rows = rows;
    config.columns = columns;
    config.integrations = updatedIntegrations;
    integrations.spotify = updatedIntegrations.spotify;
    integrations.voicemeeter = updatedIntegrations.voicemeeter;
    configuredAppIds = new Set(updatedButtons
      .filter((button) => button.type === 'application')
      .map((button) => button.appId));
    buttons = new Map(updatedButtons.map((button) => [button.id, button]));
    const updateMessage = JSON.stringify({ type: 'buttonsChanged' });
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(updateMessage);
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
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

process.on('exit', () => {
  if (sp) sp.kill();
  if (vm) vm.kill();
});

server.listen(config.port, '0.0.0.0', () => {
  const ips = Object.values(networkInterfaces()).flat()
    .filter((n) => n.family === 'IPv4' && !n.internal && isLocalIPv4(n.address))
    .map((n) => n.address);
  console.log('Abre esto en el teléfono (misma red WiFi):');
  ips.forEach((ip) => console.log(`  http://${ip}:${config.port}`));
  console.log(`Abre en este computador para mostrar los QR: http://127.0.0.1:${config.port}/connect.html`);
  connectObs();
});
