const mqtt = require('mqtt'); // Importa la librería MQTT para comunicación en tiempo real
const express = require('express'); // Importa Express para crear el servidor backend
const cors = require('cors'); // Permite solicitudes entre distintos dominios
const admin = require('firebase-admin'); // Importa Firebase Admin SDK

// =============================
// FIREBASE
// =============================
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY); // Convierte las credenciales de Firebase desde variable de entorno

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount), // Inicializa autenticación segura de Firebase
  databaseURL: "https://riego-app-bb60f-default-rtdb.firebaseio.com" // Define URL de la base de datos Firebase
});

const db = admin.database(); // Obtiene referencia principal de la base de datos


// =============================
// LIMPIEZA SEMANAL HISTORIAL
// =============================
async function limpiarHistorialSemanal(){

  try{

    const ahora = new Date(); // Obtiene la fecha y hora actual del sistema

    const esLunes = ahora.getDay() === 1; // Verifica si el día actual es lunes
    const hora = ahora.getHours(); // Obtiene la hora actual en formato de 24 horas

    // Permite la limpieza únicamente los lunes después de las 6 de la mañana
    if(!esLunes || hora < 6){
      return;
    }

    const hoy = ahora.toDateString(); // Obtiene fecha actual en formato texto

    const refControl = db.ref("config/ultimaLimpieza"); // Obtiene referencia de control de limpieza

    const snap = await refControl.once("value"); // Consulta último registro de limpieza

    const ultima = snap.val(); // Obtiene fecha almacenada en Firebase

    // si ya limpió hoy, salir
    if(ultima === hoy) return; // Evita limpiar más de una vez el mismo día

    console.log("🧹 Limpiando historial semanal..."); // Muestra inicio de limpieza

    // borrar historial completo
    await db.ref("historial").remove(); // Elimina completamente el historial

    // guardar control
    await refControl.set(hoy); // Guarda fecha de la última limpieza realizada

    console.log("✅ Historial eliminado correctamente"); // Confirma limpieza exitosa

  }catch(err){

    console.error("🔥 Error limpiando historial:", err); // Muestra errores encontrados

  }
}

// =============================
// SERVIDOR
// =============================
const app = express(); // Crea instancia principal del servidor Express
app.use(cors()); // Habilita soporte CORS
app.use(express.json()); // Permite recibir datos en formato JSON

const PORT = process.env.PORT || 3000; // Define puerto principal del servidor

// =============================
// MQTT (RECONEXIÓN SEGURA)
// =============================
const client = mqtt.connect('mqtt://broker.hivemq.com', {
  reconnectPeriod: 3000, // Reconecta automáticamente cada 3 segundos
  keepalive: 60 // Mantiene conexión activa mediante señales periódicas
});

client.on('connect', () => { // Detecta conexión MQTT exitosa
  console.log('🟢 MQTT conectado'); // Muestra conexión exitosa en consola
  client.subscribe('riego/surco/+/+', { qos: 0 }); // Se suscribe a todos los tópicos de surcos
});

client.on('reconnect', () => { // Detecta intento de reconexión MQTT
  console.log('🟡 Reintentando conexión MQTT...'); // Muestra intento de reconexión
});

client.on('error', (err) => { // Detecta errores MQTT
  console.error('🔴 Error MQTT:', err.message); // Muestra mensaje de error
});

// =============================
// VARIABLES
// =============================
const VARIABLES_VALIDAS = [
  "temp_aire",
  "hum_aire",
  "hum_tierra",
  "valvula",
  "modo",
  "umbrales"
]; // Define variables permitidas para procesamiento MQTT

const mapaVariables = {
  temp_aire: "tempAire",
  hum_aire: "humAire",
  hum_tierra: "humTierra"
}; // Relaciona variables MQTT con nombres internos del sistema

let ultimoRegistro = {}; // Guarda el último registro procesado
let ultimoEnvio = {}; // Controla frecuencia de envío de datos
let bloqueando = false; // Controla bloqueos temporales del sistema

let procesandoAuto = false; // Indica si existe un proceso automático activo

// =============================
// MQTT → FIREBASE (OPTIMIZADO)
// =============================
client.on('message', async (topic, message) => { // Detecta mensajes recibidos desde MQTT

  console.log("📡 TOPIC:", topic); // Muestra tópico recibido
  console.log("📨 MENSAJE:", message.toString()); // Muestra contenido del mensaje

  try {

    // SOLO bloquear escritura Firebase, no lógica
    const bloqueandoLocal = true; // Activa bloqueo local temporal

    const valor = message.toString(); // Convierte mensaje recibido a texto
    const [, , surcoId, variable] = topic.split('/'); // Extrae datos del tópico MQTT
    const id = parseInt(surcoId); // Convierte identificador de surco a número

    if (!VARIABLES_VALIDAS.includes(variable)) return; // Verifica que la variable sea válida

    const variableNormalizada = mapaVariables[variable] || variable; // Convierte variable MQTT a nombre interno

    // evitar duplicados exactos
    const clave = `${id}_${variableNormalizada}`; // Genera clave única para control interno

    // permitir humedad aunque sea igual (clave para automático)
    const anterior = parseFloat(ultimoRegistro[clave]);
    const actual = parseFloat(valor);

    // 🔥 si ambos son números
    if (!isNaN(anterior) && !isNaN(actual)) {

      // tolerancia mínima
      if (Math.abs(actual - anterior) < 0.5) {
        return;
      }

    } else {

      // texto normal
      if (ultimoRegistro[clave] === valor) {
        return;
      }
    }

    // THROTTLE (máx 1 cada 2 segundos)
    const ahora = Date.now(); // Obtiene tiempo actual

    // NO limitar humedad (es crítica para automático)
    if (
      ultimoEnvio[clave] &&
      ahora - ultimoEnvio[clave] < 2000
    ) return;

    ultimoEnvio[clave] = ahora; // Guarda tiempo del último envío
    ultimoRegistro[clave] = valor;

    // =========================
    // SENSORES
    // =========================
    if (["temp_aire", "hum_aire", "hum_tierra"].includes(variable)) {

      await db.ref(`surcos/${id}/sensores/${variableNormalizada}`)
        .set(valor); // Guarda sensor actualizado en Firebase

      // AUTOMÁTICO EN TIEMPO REAL
      if (variable === "hum_tierra") {

        const snapshot = await db.ref(`surcos/${id}`).once('value'); // Obtiene estado actual del surco
        const estado = snapshot.val(); // Extrae datos del surco

        await evaluarAutomaticoBackend(id, estado); // Ejecuta lógica automática de riego
      }
    }

    // =========================
    // MODO
    // =========================
    if (variable === "modo") {

      await db.ref(`surcos/${id}/modo`)
        .set(valor) // Guarda modo actual del sistema
        .catch(err => console.error("🔥 Firebase error:", err)); // Muestra errores Firebase
    }

    // =========================
    // VÁLVULA → RIEGO
    // =========================
    if (variable === "valvula") {

      await db.ref(`surcos/${id}/riego`)
        .set(valor === "ON") // Convierte estado ON/OFF a booleano
        .catch(err => console.error("🔥 Firebase error:", err)); // Muestra errores Firebase
    }

    // =========================
    // UMBRALES
    // =========================
    if (variable === "umbrales") {

      try {

        const data = JSON.parse(valor); // Convierte datos JSON recibidos

        await db.ref(`surcos/${id}/umbrales`)
          .set(data) // Guarda umbrales actualizados
          .catch(err => console.error("🔥 Firebase error:", err)); // Muestra errores Firebase

      } catch (e) {} // Ignora errores de conversión JSON
    }

    // =========================
    // HISTORIAL (CONTROLADO)
    // =========================
    await db.ref(`historial/${id}`).push({

      variable: variable, // Guarda nombre de variable recibida
      valor, // Guarda valor recibido
      tiempo: new Date().toISOString(), // Guarda fecha y hora del registro
      surco: id // Guarda identificador del surco

    });

    console.log(`📥 ${variableNormalizada} (${id}) = ${valor}`); // Muestra registro procesado

  } catch (err) {

    console.error("❌ Error general:", err); // Muestra errores generales del sistema

  } finally {

    setTimeout(() => bloqueando = false, 100); // Libera bloqueo después de breve espera

  }

});

// =============================
// FIREBASE → MQTT (SIN LOOP)
// =============================
let estadoAnterior = {}; // Guarda estado anterior de cada surco

db.ref('surcos').on('value', async snapshot => { // Detecta cambios dentro de Firebase

  const data = snapshot.val(); // Obtiene todos los datos de surcos

  if (!data) return; // Verifica existencia de datos

  for (let id in data) { // Recorre todos los surcos

    const actual = data[id]; // Obtiene estado actual
    const anterior = estadoAnterior[id] || {}; // Obtiene estado anterior almacenado

    if (actual.modo !== anterior.modo) { // Detecta cambios de modo

      client.publish(`riego/surco/${id}/modo`, actual.modo); // Envía nuevo modo por MQTT
    }

    if (actual.riego !== anterior.riego) { // Detecta cambios de riego

      client.publish(
        `riego/surco/${id}/valvula`,
        actual.riego ? "ON" : "OFF" // Convierte booleano a ON/OFF
      );
    }

    const uA = actual.umbrales || {}; // Obtiene umbrales actuales
    const uB = anterior.umbrales || {}; // Obtiene umbrales anteriores

    if (
      uA.humTierraMin !== uB.humTierraMin ||
      uA.humTierraMax !== uB.humTierraMax
    ) { // Detecta cambios en umbrales

      client.publish(
        `riego/surco/${id}/umbrales`,
        JSON.stringify({
          humTierraMin: Number(uA.humTierraMin) || 0, // Convierte humedad mínima a número
          humTierraMax: Number(uA.humTierraMax) || 0 // Convierte humedad máxima a número
        })
      );
    }

    estadoAnterior[id] = JSON.parse(JSON.stringify(actual)); // Guarda copia del estado actual
  }

});

// =============================
// KEEP ALIVE (ANTI-CRASH)
// =============================
setInterval(() => { // Ejecuta función repetitiva cada cierto tiempo

  console.log("🫀 Backend vivo:", new Date().toLocaleTimeString()); // Muestra señal de funcionamiento activo

}, 10000);

// revisar limpieza cada minuto
setInterval(() => { // Ejecuta verificación periódica de limpieza

  limpiarHistorialSemanal(); // Ejecuta limpieza automática semanal

}, 60000);

// =============================
// API
// =============================
app.get('/', (req, res) => { // Crea ruta principal del servidor

  res.send('🔥 Backend estable PRO funcionando'); // Envía mensaje de estado del backend

});

app.get('/historial', async (req, res) => { // Crea endpoint para obtener historial

  try {

    const snapshot = await db.ref('historial').once('value'); // Obtiene historial completo desde Firebase

    const data = snapshot.val() || {}; // Obtiene datos del historial o crea objeto vacío

    let resultado = []; // Arreglo final de resultados

    Object.keys(data).forEach(surco => { // Recorre todos los surcos registrados

      Object.keys(data[surco]).forEach(key => { // Recorre registros internos del surco

        resultado.push({

          ...data[surco][key], // Copia información original del registro
          surco: Number(surco) // Agrega número de surco al resultado

        });

      });

    });

    res.json(resultado); // Devuelve historial completo en formato JSON

  } catch(err){

    console.error(err); // Muestra errores en consola

    res.status(500).json({

      error: "Error obteniendo historial" // Devuelve mensaje de error al cliente

    });
  }

});

// =============================
// INICIAR SERVIDOR
// =============================
app.listen(PORT, () => { // Inicia servidor backend

  console.log(`🌐 Servidor en puerto ${PORT}`); // Muestra puerto activo del servidor

});

async function evaluarAutomaticoBackend(id, e){ // Evalúa lógica automática de riego

  if (!e) return; // Verifica existencia de datos del surco

  if (e.modo !== "AUTOMATICO") return; // Verifica que el modo sea automático

  const humedad = parseFloat(e.sensores?.humTierra); // Obtiene humedad actual de tierra

  if (isNaN(humedad)) return; // Verifica que la humedad sea válida

  const u = e.umbrales; // Obtiene configuración de umbrales

  if (!u) return; // Verifica existencia de umbrales

  const min = Number(u.humTierraMin) || 0; // Obtiene humedad mínima permitida
  const max = Number(u.humTierraMax) || 0; // Obtiene humedad máxima permitida

  if (min === 0 && max === 0) return; // Verifica configuración válida

  if (min >= max) return; // Verifica coherencia entre valores mínimo y máximo

  const estadoActual = e.riego ? "ON" : "OFF"; // Obtiene estado actual del riego

  let nuevoEstado = estadoActual; // Inicializa nuevo estado del riego

  if (estadoActual === "OFF" && humedad < min) {

    nuevoEstado = "ON"; // Activa riego si humedad es menor al mínimo
  }

  if (estadoActual === "ON" && humedad > max) {

    nuevoEstado = "OFF"; // Desactiva riego si humedad supera el máximo
  }

  if (nuevoEstado !== estadoActual) { // Verifica si existe cambio de estado

    console.log(`🌱 BACKEND AUTO ${id}: ${estadoActual} → ${nuevoEstado}`); // Muestra cambio automático en consola

    client.publish(`riego/surco/${id}/valvula`, nuevoEstado); // Envía nuevo estado de válvula por MQTT

    await db.ref(`surcos/${id}/riego`)
      .set(nuevoEstado === "ON"); // Actualiza estado del riego en Firebase
  }
}