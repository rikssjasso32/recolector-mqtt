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
  client.subscribe('riego/surco/+/+', { qos: 0 });

  client.subscribe('riego/control/+');

  client.subscribe('riego/modo/+');

  client.subscribe('riego/config/+');
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
  "umbrales",
  "config",
  "plantas"
];

const mapaVariables = {
  temp_aire: "tempAire",
  hum_aire: "humAire",
  hum_tierra: "humTierra"
}; // Relaciona variables MQTT con nombres internos del sistema

let ultimoRegistro = {}; // Guarda el último registro procesado
let ultimoEnvio = {}; // Controla frecuencia de envío de datos



// =============================
// MQTT → FIREBASE (OPTIMIZADO)
// =============================
client.on('message', (topic, message) => {

  if(process.env.DEBUG === "true"){

    console.log("📡 TOPIC:", topic);
    console.log("📨 MENSAJE:", message.toString());

  }

  try {


    const valor = message.toString(); // Convierte mensaje recibido a texto
    const partes = topic.split('/');

    let id = null;
    let variable = null;

    // FORMATO:
    // riego/surco/4/umbrales
    if(partes[1] === "surco"){

      id = parseInt(partes[2]);
      variable = partes[3];

    }

    // FORMATO:
    // riego/modo/4
    // riego/control/4
    // riego/config/4
    else{

      variable = partes[1];
      id = parseInt(partes[2]);

    }

    // NORMALIZAR
    if(variable === "control"){
      variable = "valvula";
    }

    if (!VARIABLES_VALIDAS.includes(variable)) return;

    const variableNormalizada = mapaVariables[variable] || variable; // Convierte variable MQTT a nombre interno

    // evitar duplicados exactos
    const clave = `${id}_${variableNormalizada}`; // Genera clave única para control interno
    // CONFIG NUNCA DEBE FILTRARSE
    if(variable === "config"){

      ultimoRegistro[clave] = null;
      ultimoEnvio[clave] = null;

    }

    // permitir humedad aunque sea igual (clave para automático)
    const esJSON =
      variable === "umbrales";

    let anterior = null;
    let actual = null;

    if(!esJSON){

      anterior = parseFloat(ultimoRegistro[clave]);
      actual = parseFloat(valor);

    }

    // 🔥 si ambos son números
    if (
      !esJSON &&
      !isNaN(anterior) &&
      !isNaN(actual)
    ) {

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
      !esJSON &&
      ultimoEnvio[clave] &&
      ahora - ultimoEnvio[clave] < 2000
    ) return;

    ultimoEnvio[clave] = ahora; // Guarda tiempo del último envío
    ultimoRegistro[clave] = valor;

    // =========================
    // SENSORES
    // =========================
    if (["temp_aire", "hum_aire", "hum_tierra"].includes(variable)) {

      db.ref(`surcos/${id}/sensores/${variableNormalizada}`)
        .set(valor)
        .catch(err =>
          console.error("🔥 Firebase error:", err)
        );

    }

    // =========================
    // MODO
    // =========================
    if (variable === "modo") {

    db.ref(`surcos/${id}/modo`)
      .set(
        valor === "AUTO"
          ? "AUTOMATICO"
          : valor
      )
      .catch(err =>
        console.error("🔥 Firebase error:", err)
      );
    }

    // =========================
    // VÁLVULA → RIEGO
    // =========================
    if (variable === "valvula") {

    db.ref(`surcos/${id}/riego`)
      .set(valor === "ON")
      .catch(err =>
        console.error("🔥 Firebase error:", err)
      );
    }

    // =========================
    // UMBRALES
    // =========================
    if (variable === "umbrales") {

      try {

        const data = JSON.parse(valor); // Convierte datos JSON recibidos

        db.ref(`surcos/${id}/umbrales`)
          .set(data)
          .catch(err =>
            console.error("🔥 Firebase error:", err)
          );

      } catch (e) {

        console.error("🔥 Error parseando umbrales:", e);

      }
    }

    // =========================
    // CONFIG COMPLETA
    // =========================
    if (variable === "config") {

      try {

        const data = JSON.parse(valor); // Convierte configuración completa recibida

        db.ref(`surcos/${id}/planta`)
          .set(data.planta || "")
          .catch(err =>
            console.error("🔥 Firebase error:", err)
          );

        db.ref(`surcos/${id}/plantas`)
          .set(data.plantas || [])
          .catch(err =>
            console.error("🔥 Firebase error:", err)
          );

        db.ref(`surcos/${id}/umbrales`)
          .set(data.umbrales || {})
          .catch(err =>
            console.error("🔥 Firebase error:", err)
          );

      } catch (e) {

        console.error("🔥 Error parseando config:", e);

      }
    }
    
    // =========================
    // HISTORIAL (FILTRADO)
    // =========================
    if (
      [
        "valvula",
        "modo",
        "temp_aire",
        "hum_aire",
        "hum_tierra"
      ].includes(variable)
    ) {

    db.ref(`historial/${id}`).push({

      variable: variable,

      valor,

      tiempo: new Date().toISOString(),

      surco: id

    })
    .catch(err =>
      console.error("🔥 Firebase error:", err)
    );
}

    if(process.env.DEBUG === "true"){

      console.log(
        `📥 ${variableNormalizada} (${id}) = ${valor}`
      );

    }

  } catch (err) {

    console.error("❌ Error general:", err); // Muestra errores generales del sistema

  } finally {

  }

});

// =============================
// KEEP ALIVE (ANTI-CRASH)
// =============================
if(process.env.DEBUG === "true"){

  setInterval(() => {

    console.log(
      "🫀 Backend vivo:",
      new Date().toLocaleTimeString()
    );

  }, 60000);

}

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
