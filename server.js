import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import OBSWebSocket from 'obs-websocket-js';
import { clipboard, keyboard, Key } from '@nut-tree-fork/nut-js';
import { execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import QRCode from 'qrcode';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join } from 'path';
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
let spotifyState = { available: false, title: '', artist: '', isPlaying: false };

keyboard.config.autoDelayMs = 20;

// ---------- OBS ----------
const obs = new OBSWebSocket();
let obsReady = false;
let retry = null;
let obsRefreshTimer = null;
let obsLastConnectionError = '';
let wss = null;
let obsState = {
  connected: false,
  currentScene: '',
  streaming: false,
  recording: false,
  scenes: [],
  inputs: [],
  sceneItems: {},
  inputMutes: {}
};

function integrationSnapshot() {
  return {
    obs: {
      connected: obsState.connected,
      currentScene: obsState.currentScene,
      streaming: obsState.streaming,
      recording: obsState.recording,
      scenes: obsState.scenes.map(({ sceneName }) => sceneName),
      inputs: obsState.inputs.map(({ inputName }) => inputName),
      sceneItems: obsState.sceneItems,
      inputMutes: obsState.inputMutes
    },
    spotify: spotifyState
  };
}

function publishIntegrationState() {
  if (!wss) return;
  const message = JSON.stringify({ type: 'integrationState', state: integrationSnapshot() });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(message);
  });
}

function scheduleRetry() {
  const wasConnected = obsReady || obsState.connected;
  obsReady = false;
  obsState.connected = false;
  if (wasConnected) publishIntegrationState();
  if (retry) return;
  retry = setTimeout(() => { retry = null; connectObs(); }, 5000);
}

async function refreshObsState() {
  if (!obsReady) return;
  try {
    const [sceneList, inputList, currentScene, streamStatus, recordStatus] = await Promise.all([
      obs.call('GetSceneList'),
      obs.call('GetInputList'),
      obs.call('GetCurrentProgramScene'),
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus')
    ]);
    const sceneItems = {};
    await Promise.all(sceneList.scenes.map(async ({ sceneName }) => {
      const { sceneItems: items } = await obs.call('GetSceneItemList', { sceneName });
      sceneItems[sceneName] = items.map(({ sourceName, sceneItemEnabled }) => ({
        sourceName,
        enabled: sceneItemEnabled
      }));
    }));
    obsState = {
      connected: true,
      currentScene: currentScene.sceneName || currentScene.currentProgramSceneName,
      streaming: streamStatus.outputActive,
      recording: recordStatus.outputActive,
      scenes: sceneList.scenes,
      inputs: inputList.inputs,
      sceneItems,
      inputMutes: obsState.inputMutes
    };
    publishIntegrationState();
  } catch (error) {
    console.error('No se pudo actualizar el estado de OBS:', error.message);
  }
}

function scheduleObsRefresh() {
  if (obsRefreshTimer) clearTimeout(obsRefreshTimer);
  obsRefreshTimer = setTimeout(() => {
    obsRefreshTimer = null;
    refreshObsState();
  }, 100);
}

async function connectObs() {
  try {
    await obs.connect(config.obs.url, config.obs.password || undefined);
    obsReady = true;
    obsLastConnectionError = '';
    await refreshObsState();
    console.log('OBS conectado');
  } catch (error) {
    if (error.message !== obsLastConnectionError) {
      console.log('OBS (opcional) sin conexión (' + error.message + '); se reintentará en 5 s...');
      obsLastConnectionError = error.message;
    }
    scheduleRetry();
  }
}
obs.on('ConnectionClosed', scheduleRetry);
obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
  obsState.currentScene = sceneName;
  publishIntegrationState();
});
obs.on('StreamStateChanged', ({ outputActive }) => {
  obsState.streaming = outputActive;
  publishIntegrationState();
});
obs.on('RecordStateChanged', ({ outputActive }) => {
  obsState.recording = outputActive;
  publishIntegrationState();
});
obs.on('InputMuteStateChanged', ({ inputName, inputMuted }) => {
  const input = obsState.inputs.find((entry) => entry.inputName === inputName);
  if (input) input.inputMuted = inputMuted;
  obsState.inputMutes[inputName] = inputMuted;
  publishIntegrationState();
});
['SceneListChanged', 'SceneNameChanged', 'InputCreated', 'InputRemoved', 'InputNameChanged', 'SceneItemCreated', 'SceneItemRemoved', 'SceneItemEnableStateChanged']
  .forEach((eventName) => obs.on(eventName, scheduleObsRefresh));

const obsActions = {
  scene: (b) => obs.call('SetCurrentProgramScene', { sceneName: b.value }),
  toggleStream: () => obs.call('ToggleStream'),
  startStream: () => obs.call('StartStream'),
  stopStream: () => obs.call('StopStream'),
  toggleRecord: () => obs.call('ToggleRecord'),
  toggleMute: (b) => obs.call('ToggleInputMute', { inputName: b.value }),
  // Muestra/oculta una fuente dentro de una escena. Si no pones "scene", usa la escena activa.
  toggleSource: async (b) => {
    let sceneName = b.scene;
    if (!sceneName) {
      const currentScene = await obs.call('GetCurrentProgramScene');
      sceneName = currentScene.sceneName || currentScene.currentProgramSceneName;
    }
    const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName, sourceName: b.value });
    const { sceneItemEnabled } = await obs.call('GetSceneItemEnabled', { sceneName, sceneItemId });
    await obs.call('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: !sceneItemEnabled });
  },
};

const OBS_ACTIONS = new Set(['scene', 'toggleStream', 'startStream', 'stopStream', 'toggleRecord', 'toggleMute', 'toggleSource']);
const SPOTIFY_COMMANDS = new Set(['playpause', 'next', 'prev']);
let spotifyProcess = null;
let spotifyBuffer = '';
let spotifyErrorOutput = '';
let spotifyRequestId = 0;
const spotifyWaiting = new Map();
let spotifyLastError = '';

function invalidEditorInput(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function isExistingDirectory(folderPath) {
  try {
    return statSync(folderPath).isDirectory();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG'].includes(error.code)) return false;
    throw error;
  }
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
    applicationDiscoveryError = 'No se pudieron detectar las aplicaciones instaladas: ' + error.message;
    console.error(applicationDiscoveryError);
    return new Map();
  }
}

function validateEditorButtons(value, capacity) {
  if (!Array.isArray(value) || value.length > 100) {
    invalidEditorInput('La botonera debe tener entre 0 y 100 botones');
  }

  const ids = new Set();
  const positionsByGroup = new Map();
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
    const hasPosition = Object.prototype.hasOwnProperty.call(button, 'position');
    if (hasPosition && !Number.isInteger(button.position)) {
      invalidEditorInput('La posición del botón debe ser un número entero');
    }
    if (!positionsByGroup.has(group)) positionsByGroup.set(group, new Set());
    const groupPositions = positionsByGroup.get(group);
    let position = button.position;
    if (!hasPosition) {
      position = 0;
      while (groupPositions.has(position)) position += 1;
    }
    if (position < 0 || position >= capacity || groupPositions.has(position)) {
      invalidEditorInput('Cada perfil debe tener como máximo un botón por casilla dentro de la cuadrícula');
    }
    groupPositions.add(position);
    if (iconType === 'tabler' ? !tablerIcons.has(icon) : iconType !== 'emoji' || icon.length > 12) {
      invalidEditorInput('Selecciona un icono válido');
    }
    ids.add(id);

    const result = { id, label, group, icon, iconType, position };
    for (const field of ['accent', 'background', 'contentColor']) {
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
    } else if (button.type === 'text') {
      if (typeof button.text !== 'string' || !button.text.trim() || button.text.length > 2000 ||
          /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(button.text)) {
        invalidEditorInput('El texto debe tener entre 1 y 2000 caracteres válidos');
      }
      result.type = 'text';
      result.text = button.text;
    } else if (button.type === 'spotify') {
      if (!SPOTIFY_COMMANDS.has(button.cmd)) invalidEditorInput('Comando de Spotify no válido');
      result.type = 'spotify';
      result.cmd = button.cmd;
    } else if (button.type === 'folder') {
      const folderPath = typeof button.path === 'string' ? button.path.trim() : '';
      if (!folderPath || folderPath.length > 1024 || !isAbsolute(folderPath) ||
          !/^[a-zA-Z]:\\/.test(folderPath) || !isExistingDirectory(folderPath)) {
        invalidEditorInput('Selecciona una carpeta local existente con una ruta como C:\\Users\\...');
      }
      result.type = 'folder';
      result.path = folderPath;
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
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'spotify.ps1')],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  spotifyProcess = child;
  spotifyBuffer = '';
  spotifyErrorOutput = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => {
    spotifyBuffer += data;
    let end;
    while ((end = spotifyBuffer.indexOf('\n')) >= 0) {
      const line = spotifyBuffer.slice(0, end).trim();
      spotifyBuffer = spotifyBuffer.slice(end + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line);
        const pending = spotifyWaiting.get(response.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        spotifyWaiting.delete(response.id);
        if (!response.ok) pending.reject(new Error(response.error || 'La sesión multimedia de Spotify falló'));
        else pending.resolve(response.value);
      } catch (error) {
        console.error('Respuesta inválida de la integración multimedia de Windows:', error.message);
      }
    }
  });
  child.stderr.on('data', (data) => {
    spotifyErrorOutput = (spotifyErrorOutput + data).slice(-2000);
  });
  const failPending = (error) => {
    if (spotifyProcess === child) spotifyProcess = null;
    spotifyWaiting.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
    spotifyWaiting.clear();
  };
  child.on('error', failPending);
  child.on('exit', (code) => {
    if (spotifyProcess !== child) return;
    const details = spotifyErrorOutput.trim();
    failPending(new Error(details || `La integración multimedia de Windows terminó (${code})`));
  });
}

function spotifyRequest(action) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('La sesión multimedia de Spotify solo está disponible en Windows'));
  }
  if (!spotifyProcess) startSpotifyHelper();
  const id = ++spotifyRequestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      spotifyWaiting.delete(id);
      if (spotifyProcess) spotifyProcess.kill();
      reject(new Error('Tiempo de espera agotado al consultar la sesión multimedia de Spotify'));
    }, 5000);
    spotifyWaiting.set(id, { resolve, reject, timer });
    spotifyProcess.stdin.write(JSON.stringify({ id, action }) + '\n', (error) => {
      if (!error) return;
      clearTimeout(timer);
      spotifyWaiting.delete(id);
      reject(error);
    });
  });
}

async function refreshSpotifyState() {
  try {
    const state = await spotifyRequest('status');
    const next = {
      available: state.available === true,
      title: state.title || '',
      artist: state.artist || '',
      isPlaying: state.isPlaying === true
    };
    spotifyLastError = '';
    if (JSON.stringify(next) !== JSON.stringify(spotifyState)) {
      spotifyState = next;
      publishIntegrationState();
    }
  } catch (error) {
    if (error.message !== spotifyLastError) {
      console.error('No se pudo consultar la sesión multimedia de Spotify:', error.message);
      spotifyLastError = error.message;
    }
    if (spotifyState.available) {
      spotifyState = { available: false, title: '', artist: '', isPlaying: false };
      publishIntegrationState();
    }
  }
}

const spotifyPoll = setInterval(refreshSpotifyState, 1500);
spotifyPoll.unref();

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
  let workingDirectory = dirname(application.path);
  if (/^obs(?:64)?\.exe$/i.test(basename(application.path))) {
    let candidate = workingDirectory;
    for (let depth = 0; depth < 4; depth += 1) {
      if (existsSync(join(candidate, 'data', 'obs-studio', 'locale', 'en-US.ini'))) {
        workingDirectory = candidate;
        break;
      }
      candidate = dirname(candidate);
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(application.path, [], {
      cwd: workingDirectory,
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

function launchFolder(folderPath) {
  if (process.platform !== 'win32') throw new Error('Abrir carpetas solo está disponible en Windows');
  if (typeof folderPath !== 'string' || !isAbsolute(folderPath) || !/^[a-zA-Z]:\\/.test(folderPath) ||
      !isExistingDirectory(folderPath)) {
    throw new Error('La carpeta ya no está disponible; selecciónala de nuevo en el editor');
  }
  return new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', [folderPath], {
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
  } else if (b.type === 'text') {
    await clipboard.setContent(b.text);
    try {
      await keyboard.pressKey(Key.LeftControl, Key.V);
    } finally {
      await keyboard.releaseKey(Key.LeftControl, Key.V);
    }
  } else if (b.type === 'spotify') {
    if (!integrations.spotify) throw new Error('La integración de Spotify está desactivada');
    if (process.platform !== 'win32') throw new Error('El control de Spotify solo funciona en Windows');
    if (!SPOTIFY_COMMANDS.has(b.cmd)) throw new Error('Comando de Spotify desconocido: ' + b.cmd);
    await spotifyRequest(b.cmd);
  } else if (b.type === 'application') {
    await launchApplication(b.appId);
  } else if (b.type === 'folder') {
    await launchFolder(b.path);
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
  res.json(config.buttons.filter(isButtonEnabled).map(({ id, group, label, icon, iconType, accent, contentColor, background, image }) => ({
    id, group, label, icon, iconType, accent, contentColor, background, image
  })));
});
app.get('/editor', (_req, res) => {
  const columns = config.columns || 0;
  const rows = config.rows || (columns ? Math.ceil(config.buttons.length / columns) : 0);
  res.json({ buttons: config.buttons, rows, columns, integrations, discovery: integrationSnapshot() });
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
    if (!Number.isInteger(rows) || rows < 3 || rows > 12 ||
        !Number.isInteger(columns) || columns < 5 || columns > 12) {
      invalidEditorInput('La cuadrícula debe tener al menos 3 filas y 5 columnas, con un máximo de 12');
    }
    const updatedButtons = validateEditorButtons(req.body && req.body.buttons, rows * columns);

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
wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'integrationState', state: integrationSnapshot() }));
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
  if (spotifyProcess) spotifyProcess.kill();
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
