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

## APK para Android

El APK es un cliente: el servidor y la configuración siguen en el PC. Instala y ejecuta
el servidor en el computador; en Android, abre la app e introduce la URL que aparece en
la consola o escanea el QR de `http://127.0.0.1:3000/connect.html` abierto en el PC. La
app recuerda la última dirección y ofrece ambas opciones cuando vuelves a la pantalla de
conexión. Cada teléfono debe estar en la misma red Wi-Fi que el PC.

Para compilar el APK, instala Android Studio con Android SDK 35 y abre la carpeta
`android-client`. Después de sincronizar Gradle, selecciona **Build → Build APK(s)**.
El APK de prueba se genera en `android-client/app/build/outputs/apk/debug/app-debug.apk`.
No contiene el servidor ni funciona sin conexión al PC.

## Panel

Usa los filtros de perfiles para mostrar cada grupo.
Los botones del teléfono envían sus acciones al computador; no hace falta instalar una
aplicación en el teléfono.

Pulsa **Editar** para agregar, editar, borrar y reordenar botones, crear perfiles, ajustar
la cuadrícula en filas × columnas (0 × 0 la calcula automáticamente) y personalizar
iconos emoji o de la biblioteca Tabler, imágenes y colores. **Guardar cambios**
actualiza la configuración del PC y de todos los dispositivos conectados. Las imágenes
PNG, JPG y WebP pueden pesar hasta 500 KB.

En **Integraciones de este computador**, desactiva Spotify o Voicemeeter para ocultar sus
botones del panel sin borrar su diseño. Los cambios se comparten con los teléfonos
conectados; desactivar una integración no cierra la aplicación.

Para crear un atajo de aplicación, agrega un botón y elige **Abrir aplicación instalada**.
El selector muestra accesos directos del Menú Inicio que apuntan directamente a una
aplicación instalada; no ejecuta comandos ni acepta rutas escritas. El botón abre la app
en el computador que ejecuta el servidor. Si instalas una aplicación nueva, reinicia el
servidor para detectarla.

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

### Voicemeeter Banana

Voicemeeter debe estar ejecutándose. El perfil **Voicemeeter** controla sus canales por
medio de la Remote API incluida con la instalación: mute y volumen para Micrófono
(Hardware Input 1), Spotify (Hardware Input 3), Escritorio (Voicemeeter VAIO) y Discord
(Voicemeeter AUX); además de mute para A1/B1 y volumen maestro A1. Los botones de volumen
cambian el fader en pasos de 1% sobre el rango de -60 a +12 dB; el mute es independiente.

## Personalización

Edita la lista `buttons` de `config.json` para cambiar nombres, iconos o acciones. Después
de modificar el archivo, reinicia el servidor. Las acciones disponibles para OBS incluyen
`scene`, `startStream`, `stopStream`, `toggleStream`, `toggleRecord` y `toggleMute`.

## Seguridad

Cualquier dispositivo con acceso a la misma red puede abrir el panel, activar botones,
abrir las aplicaciones configuradas y editar la configuración compartida. Úsalo solo en
una red de confianza y no expongas el servidor directamente a Internet.
