# Stream Deck casero

Convierte un teléfono en una botonera para controlar OBS, Discord y Spotify desde la
misma red Wi-Fi. El teléfono muestra el panel; el computador ejecuta las acciones.

## Requisitos

- Windows para el control de Spotify y la configuración actual de Discord.
- Node.js 18 o superior.
- OBS Studio 28 o superior si vas a usar sus botones.
- Teléfono y computador conectados a la misma red Wi-Fi.

## Inicio

1. Instala las dependencias con `npm install`.
2. Inicia el servidor con `npm start`.
3. Abre en el teléfono la dirección que aparece en la consola, por ejemplo
   `http://192.168.1.10:3000`.
4. Opcionalmente, añade la página a la pantalla de inicio del teléfono para abrirla
   como una aplicación.

Mantén la consola del servidor abierta mientras uses el panel. Si el teléfono no puede
conectarse, permite Node.js en el firewall de Windows para redes privadas y confirma que
ambos dispositivos estén en la misma Wi-Fi.

## Panel

Usa los filtros **Todos**, **OBS**, **Discord** y **Spotify** para mostrar cada grupo.
Los botones del teléfono envían sus acciones al computador; no hace falta instalar una
aplicación en el teléfono.

### OBS

1. En OBS, ve a **Herramientas → Ajustes del servidor WebSocket** y habilita el servidor
   (normalmente usa el puerto `4455`).
2. Si configuraste contraseña, guarda la misma en `config.json`, en `obs.password`.
3. Los nombres de escena y fuentes de `config.json` deben coincidir exactamente con los
   que aparecen en OBS.

El panel incluye cambio de escena, controles de micrófono/cámara y botones separados para
**Iniciar directo** y **Terminar directo**. OBS debe estar conectado para que funcionen.

### Discord

Los botones de Discord envían `LeftShift + Num1` para silenciar y `LeftShift + Num2` para
ensordecer. Configura esos mismos atajos en **Ajustes de usuario → Combinaciones de teclas**
de Discord. Si prefieres otras teclas, cambia los valores `keys` de esos botones en
`config.json`.

### Spotify

Spotify debe estar abierto en el computador. Los controles de anterior, reproducir/pausar,
siguiente y volumen envían comandos a su ventana; no requieren Premium. Si Spotify no está
abierto o no tiene una ventana visible, el panel mostrará un error.

## Personalización

Edita la lista `buttons` de `config.json` para cambiar nombres, iconos o acciones. Después
de modificar el archivo, reinicia el servidor. Las acciones disponibles para OBS incluyen
`scene`, `startStream`, `stopStream`, `toggleStream`, `toggleRecord` y `toggleMute`.

## Seguridad

Cualquier dispositivo con acceso a la misma red puede abrir el panel y activar sus
botones. Úsalo solo en una red de confianza y no expongas el servidor directamente a
Internet.

##
Plataforma desarrollada por Sebastian Gomez https://www.sebas-gomez.com/
