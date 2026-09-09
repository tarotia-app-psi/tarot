const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const rateLimit = require('express-rate-limit');
const app = express();

const corsOptions = {
    origin: [
        'https://tarot-ia.netlify.app',
        'https://tarotia-app-psi.github.io',
        'http://localhost:3000',
        'http://127.0.0.1:5500',
        'http://localhost:5500'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
    credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(express.static(__dirname));

// En tu server.js, asegúrate de que la URI incluya el nombre de la base de datos:
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://edu1826_db_user:GATO8objeto@cluster0.39xxpjk.mongodb.net/tarotApp?retryWrites=true&w=majority";
const MODEL_NAME = process.env.MODEL_NAME || 'openai/gpt-oss-20b';
const API_KEY = process.env.GROQ_API_KEY || process.env.API_KEY;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const JWT_SECRET = process.env.JWT_SECRET || 'tarotia-secret-key-2026';
const MAX_MUESTRAS_FISICAS = 5;

console.log('CONFIG SERVIDOR:');
console.log('  MODEL_NAME:', MODEL_NAME);
console.log('  API_KEY existe:', !!API_KEY);
console.log('  ADMIN_TOKEN existe:', !!ADMIN_TOKEN);
console.log('  MONGO_URI existe:', !!MONGO_URI);

const UsuarioSchema = new mongoose.Schema({
    nombre: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    plan: { type: String, enum: ['Gratis', 'Premium'], default: 'Gratis' },
    totalTiradas: { type: Number, default: 0 },
    muestrasFisicasUsadas: { type: Number, default: 0 },
    ultimaConexion: { type: String, default: () => new Date().toISOString().split('T')[0] },
    codigoPremiumUsado: { type: String, default: null }
}, { timestamps: true });

const Usuario = mongoose.models.Usuario || mongoose.model('Usuario', UsuarioSchema);

const CodigoPremiumSchema = new mongoose.Schema({
    codigo: { type: String, required: true, unique: true, uppercase: true },
    usado: { type: Boolean, default: false },
    usadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', default: null },
    fechaUso: { type: Date, default: null }
}, { timestamps: true });

const CodigoPremium = mongoose.models.CodigoPremium || mongoose.model('CodigoPremium', CodigoPremiumSchema);

// Schema explícito para duplas conectando directamente a la colección 'duplas' sin índices duplicados
const DuplaSchema = new mongoose.Schema({
    claveBuscador: { type: String, required: true },
    cartaA: { type: String, required: true },
    cartaB: { type: String, required: true },
    significado: { type: String, required: true },
    keywords: [{ type: String }]
}, { timestamps: true, collection: 'duplas' });

DuplaSchema.index({ claveBuscador: 1 }, { unique: true });
DuplaSchema.index({ cartaA: 1, cartaB: 1 });

const Dupla = mongoose.models.Dupla || mongoose.model('Dupla', DuplaSchema);

if (MONGO_URI) {
    mongoose.connect(MONGO_URI)
        .then(async () => {
            console.log("Conectado a MongoDB Atlas con éxito.");
            try {
                const count = await Dupla.countDocuments();
                console.log(`📊 [DIAGNÓSTICO] Documentos encontrados mediante modelo Dupla: ${count}`);
                
                if (count > 0) {
                    const sample = await Dupla.findOne({});
                    console.log("🔍 [DIAGNÓSTICO] Muestra exacta leída por el modelo Dupla:", sample);
                } else {
                    console.log("⚠️ [DIAGNÓSTICO] ¡La colección del modelo Dupla está vacía!");
                }
            } catch (e) {
                console.error("❌ Error en diagnóstico del modelo:", e);
            }
        })
        .catch(err => console.error('Error MongoDB:', err.message));
} else {
    console.warn('MONGO_URI no configurada.');
}

function verificarAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!ADMIN_TOKEN) return res.status(500).json({ error: 'Configuracion incompleta.' });
    if (!token || token !== ADMIN_TOKEN) return res.status(403).json({ error: 'Acceso denegado.' });
    next();
}

function verificarAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido.' });
    try {
        req.usuario = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Token invalido o expirado.' });
    }
}
// 🛡️ Protección contra bots: máximo 15 tiradas por IP cada 15 minutos
const tiradaLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 15, // Máximo 15 tiradas por IP cada 15 minutos
    message: { error: 'Demasiadas solicitudes. Por favor, espera unos minutos antes de consultar de nuevo.' }
});
app.post('/api/auth/registrar', async (req, res) => {
    const { nombre, email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: 'Email invalido.' });
    }
    const nombreLimpio = (nombre && typeof nombre === 'string') ? nombre.trim() : 'Consultante';
    const emailLimpio = email.toLowerCase().trim();

    try {
        let usuario = await Usuario.findOne({ email: emailLimpio });
        if (usuario) {
            usuario.nombre = nombreLimpio;
            usuario.ultimaConexion = new Date().toISOString().split('T')[0];
            await usuario.save();
        } else {
            usuario = new Usuario({
                nombre: nombreLimpio,
                email: emailLimpio,
                plan: 'Gratis',
                totalTiradas: 0,
                muestrasFisicasUsadas: 0
            });
            await usuario.save();
        }

        const token = jwt.sign(
            { userId: usuario._id, email: usuario.email, plan: usuario.plan },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            mensaje: 'Usuario registrado',
            token,
            usuario: {
                id: usuario._id,
                nombre: usuario.nombre,
                email: usuario.email,
                plan: usuario.plan,
                totalTiradas: usuario.totalTiradas,
                muestrasFisicasRestantes: Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas)
            }
        });
    } catch (error) {
        console.error('Error en registro:', error);
        res.status(500).json({ error: 'Error al registrar usuario.' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ error: 'Email invalido.' });
    }
    const emailLimpio = email.toLowerCase().trim();

    try {
        const usuario = await Usuario.findOne({ email: emailLimpio });
        if (!usuario) {
            return res.status(404).json({ error: 'Usuario no encontrado. Registrate primero.' });
        }

        usuario.ultimaConexion = new Date().toISOString().split('T')[0];
        await usuario.save();

        const token = jwt.sign(
            { userId: usuario._id, email: usuario.email, plan: usuario.plan },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            mensaje: 'Login exitoso',
            token,
            usuario: {
                id: usuario._id,
                nombre: usuario.nombre,
                email: usuario.email,
                plan: usuario.plan,
                totalTiradas: usuario.totalTiradas,
                muestrasFisicasRestantes: Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas)
            }
        });
    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ error: 'Error al iniciar sesion.' });
    }
});

app.get('/api/auth/perfil', verificarAuth, async (req, res) => {
    try {
        const usuario = await Usuario.findById(req.usuario.userId);
        if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });

        res.json({
            usuario: {
                id: usuario._id,
                nombre: usuario.nombre,
                email: usuario.email,
                plan: usuario.plan,
                totalTiradas: usuario.totalTiradas,
                muestrasFisicasRestantes: Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas)
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener perfil.' });
    }
});
// Ruta de Keep-Alive para evitar que Render se duerma
app.get('/api/ping', (req, res) => {
    res.status(200).send('¡Servidor despierto y operativo! 🔮');
});

app.post('/api/auth/canjear-codigo', verificarAuth, async (req, res) => {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ error: 'Codigo requerido.' });

    const codigoLimpio = codigo.trim().toUpperCase();

    try {
        const codigosAdmin = ['ADMIN2026', 'PASEMISTICO', 'TAROTGRATIS'];

        if (codigosAdmin.includes(codigoLimpio)) {
            const usuario = await Usuario.findById(req.usuario.userId);
            usuario.plan = 'Premium';
            usuario.codigoPremiumUsado = codigoLimpio;
            await usuario.save();

            const nuevoToken = jwt.sign(
                { userId: usuario._id, email: usuario.email, plan: usuario.plan },
                JWT_SECRET,
                { expiresIn: '30d' }
            );

            return res.json({
                mensaje: 'Codigo premium activado con exito.',
                token: nuevoToken,
                usuario: {
                    id: usuario._id,
                    nombre: usuario.nombre,
                    email: usuario.email,
                    plan: usuario.plan,
                    totalTiradas: usuario.totalTiradas,
                    muestrasFisicasRestantes: Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas)
                }
            });
        }

        const codigoDB = await CodigoPremium.findOne({ codigo: codigoLimpio });
        if (!codigoDB) return res.status(400).json({ error: 'Codigo invalido.' });
        if (codigoDB.usado) return res.status(400).json({ error: 'Codigo ya utilizado.' });

        const usuario = await Usuario.findById(req.usuario.userId);
        usuario.plan = 'Premium';
        usuario.codigoPremiumUsado = codigoLimpio;
        await usuario.save();

        codigoDB.usado = true;
        codigoDB.usadoPor = usuario._id;
        codigoDB.fechaUso = new Date();
        await codigoDB.save();

        const nuevoToken = jwt.sign(
            { userId: usuario._id, email: usuario.email, plan: usuario.plan },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            mensaje: 'Codigo premium activado con exito.',
            token: nuevoToken,
            usuario: {
                id: usuario._id,
                nombre: usuario.nombre,
                email: usuario.email,
                plan: usuario.plan,
                totalTiradas: usuario.totalTiradas,
                muestrasFisicasRestantes: Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas)
            }
        });
    } catch (error) {
        console.error('Error al canjear codigo:', error);
        res.status(500).json({ error: 'Error al procesar el codigo.' });
    }
});

app.post('/api/tiradas/usar-muestra', verificarAuth, async (req, res) => {
    try {
        const usuario = await Usuario.findById(req.usuario.userId);

        if (usuario.plan === 'Premium') {
            return res.json({ premium: true, muestrasRestantes: 999 });
        }

        const restantes = Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas);
        if (restantes <= 0) {
            return res.status(403).json({ 
                error: 'Muestras agotadas.', 
                muestrasRestantes: 0,
                premium: false 
            });
        }

        usuario.muestrasFisicasUsadas += 1;
        await usuario.save();

        res.json({
            premium: false,
            muestrasRestantes: Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas)
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al registrar muestra.' });
    }
});

app.get('/api/tiradas/muestras', verificarAuth, async (req, res) => {
    try {
        const usuario = await Usuario.findById(req.usuario.userId);
        res.json({
            premium: usuario.plan === 'Premium',
            muestrasRestantes: usuario.plan === 'Premium' 
                ? 999 
                : Math.max(0, MAX_MUESTRAS_FISICAS - usuario.muestrasFisicasUsadas)
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al consultar muestras.' });
    }
});

app.post('/api/tiradas/registrar', verificarAuth, async (req, res) => {
    try {
        const usuario = await Usuario.findById(req.usuario.userId);
        usuario.totalTiradas += 1;
        usuario.ultimaConexion = new Date().toISOString().split('T')[0];
        await usuario.save();
        res.json({ totalTiradas: usuario.totalTiradas });
    } catch (error) {
        res.status(500).json({ error: 'Error al registrar tirada.' });
    }
});

app.get('/api/duplas/buscar', async (req, res) => {
    const { a, b } = req.query;
    if (!a || !b) return res.status(400).json({ error: 'Faltan cartas.' });

    try {
        const cartaA = a.trim();
        const cartaB = b.trim();
        
        // Solo buscamos en el orden exacto: cartaA primero y cartaB después
        const claves = [
            `"${cartaA}"|"${cartaB}"`,  // Con comillas (como están en MongoDB)
            `${cartaA}|${cartaB}`       // Sin comillas (por si acaso)
        ];
        
        console.log(`🔍 Buscando (orden exacto):`, claves);

        let dupla = await Dupla.findOne({
            $or: claves.map(clave => ({ claveBuscador: clave }))
        });

        if (!dupla) {
            return res.json({ encontrada: false, mensaje: 'Dupla no encontrada' });
        }

        res.json({
            encontrada: true,
            significado: dupla.significado,
            keywords: dupla.keywords || [],
            orden: 'directo'
        });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: 'Error al buscar dupla.' });
    }
});

function extraerRespuesta(texto) {
    if (!texto) return '';
    const idxCierre = texto.lastIndexOf('</thinking>');
    if (idxCierre !== -1) {
        const despues = texto.substring(idxCierre + 11).trim();
        if (despues.length > 20) return despues;
    }
    const idxApertura = texto.indexOf('<thinking>');
    if (idxApertura !== -1) {
        const antes = texto.substring(0, idxApertura).trim();
        const despuesDelTag = texto.substring(idxApertura + 10);
        const idxCierre2 = despuesDelTag.indexOf('</thinking>');
        if (idxCierre2 !== -1) {
            const despues = despuesDelTag.substring(idxCierre2 + 11).trim();
            if (despues.length > 20) return despues;
        }
        if (antes.length > 20) return antes;
    }
    return texto.trim();
}

mongoose.connection.once('open', async () => {
    console.log("✅ Conectado a MongoDB Atlas con éxito.");
    
    try {
        const db = mongoose.connection.db;
        
        // 1. Verificar qué colecciones existen
        const colecciones = await db.listCollections().toArray();
        console.log("📚 Colecciones disponibles:");
        colecciones.forEach(c => console.log(`   - ${c.name}`));
        
        // 2. Verificar directamente en la colección 'duplas'
        const coleccionDuplas = db.collection('duplas');
        const countDirecto = await coleccionDuplas.countDocuments();
        console.log(`📊 [DIRECTO] Documentos en 'duplas': ${countDirecto}`);
        
        if (countDirecto > 0) {
            // 3. Obtener un ejemplo para ver la estructura
            const ejemplo = await coleccionDuplas.findOne({});
            console.log("📄 Ejemplo de documento:");
            console.log(JSON.stringify(ejemplo, null, 2));
            
            // 4. Verificar el modelo de Mongoose
            const countModelo = await Dupla.countDocuments();
            console.log(`📊 [MODELO] Documentos en modelo Dupla: ${countModelo}`);
            
            if (countModelo === 0) {
                console.log("⚠️ ¡INCONSISTENCIA! El modelo no ve los datos.");
                console.log("   - Posible causa: El modelo está usando otra colección o base de datos.");
                
                // 5. Verificar el nombre de la colección en el modelo
                console.log(`   - Colección en el modelo: "${Dupla.collection.name}"`);
                console.log(`   - Base de datos en el modelo: "${Dupla.db.name}"`);
            }
        }
    } catch (error) {
        console.error("❌ Error en diagnóstico:", error);
    }
});
app.post('/tirada', tiradaLimiter, async (req, res) => {
    let { tema, a, b, c, d, estilo = 'filosofico', pregunta, cartas, modo } = req.body;
    if (!a && cartas && Array.isArray(cartas) && cartas.length >= 4) {
        a = cartas[0]; b = cartas[1]; c = cartas[2]; d = cartas[3];
    }
    if (!a || !b || !c || !d) {
        return res.status(400).json({ error: 'Faltan cartas.' });
    }
    if (!API_KEY) {
        return res.status(500).json({ error: 'API Key no configurada.' });
    }

    try {
        const preguntaLimpia = (pregunta && typeof pregunta === 'string') ? pregunta.trim().slice(0, 300) : '';
        const esPreguntaEspecifica = (tema === 'Pregunta Especifica' || tema === 'Pregunta Específica') && preguntaLimpia.length > 0;
        const esModoGratis = modo === 'gratis';

        // ==========================================
        // NUEVO: DETECTAR EL ENFOQUE DEL TEMA
        // ==========================================
        let enfoqueTema = "";
        const temaLower = (tema || "").toLowerCase();
        
        if (temaLower.includes('amor') || temaLower.includes('relacion') || temaLower.includes('pareja') || temaLower.includes('sentimiento')) {
            enfoqueTema = "ENFOQUE OBLIGATORIO: Interpreta las cartas específicamente en el contexto de AMOR, relaciones, vínculos emocionales, atracción y pareja.";
        } else if (temaLower.includes('negocio') || temaLower.includes('dinero') || temaLower.includes('trabajo') || temaLower.includes('finanzas') || temaLower.includes('carrera')) {
            enfoqueTema = "ENFOQUE OBLIGATORIO: Interpreta las cartas específicamente en el contexto de TRABAJO, negocios, finanzas, proyectos y éxito material.";
        } else {
            enfoqueTema = "ENFOQUE OBLIGATORIO: Interpreta las cartas en un contexto de VIDA GENERAL, bienestar, equilibrio y tendencias amplias de la vida.";
        }

        let systemPrompt = '';
        let userPrompt = '';
        let temp = 0.7;

        if (esModoGratis) {
            systemPrompt = `Eres experta lectora de Tarot. Estilo humano, cálido, directo y CONCRETO.
${enfoqueTema}

REGLAS ABSOLUTAS:
1. Usa palabras CONCRETAS y DIRECTAS (adinerado, materialista, sensible, exitoso, feliz, intuitivo).
2. NO uses frases abstractas.
3. Las cartas pueden describir AL CONSULTANTE ("Eres...") o a ALGUIEN QUE LLEGA ("Llega alguien...").
4. PROHIBIDO mencionar nombres de cartas.
5. PROHIBIDO el relleno psicológico.
6. Completa SIEMPRE todas las secciones.
7. **Dupla 2 (Futuro) debe describir EVOLUCIÓN o ACCIÓN FUTURA, no estado estático.**

VERBOS CORRECTOS PARA DUPLA 2 (FUTURO):
- "avanzará", "atravesará", "logrará", "enfrentará", "superará", "llegará", "alcanzará", "descubrirá", "recibirá"

VERBOS PROHIBIDOS PARA DUPLA 2:
- ❌ "sigue sintiendo", "se mantiene", "continúa", "permanece"

EJEMPLO PERFECTO (4 de Oros + 7 de Copas, luego Templanza + 10 de Copas):
- Dupla 1: "Persona materialista que se vuelve más sensible."
- Dupla 2: "Con tranquilidad y paciencia, logrará la felicidad familiar y social."

FORMATO (2 secciones HTML):
<div class="reading-section">
    <h3>Dupla 1: Tu Presente</h3>
    <p>[2-3 oraciones concretas describiendo a la persona, adaptadas al ${tema}. Sé directo.]</p>
</div>
<div class="reading-section">
    <h3>Dupla 2: Tu Evolución Futura</h3>
    <p>[2-3 oraciones con verbos de ACCIÓN FUTURA, adaptadas al ${tema}. NO estados estáticos.]</p>
</div>`;

            userPrompt = `Tema de consulta: ${tema}.
Pregunta: "${preguntaLimpia || 'Consulta general'}"
Cartas: Dupla 1 (${a} y ${b}), Dupla 2 (${c} y ${d}).
Describe a la persona con palabras CONCRETAS adaptadas al tema de ${tema}. La Dupla 2 debe usar verbos de acción futura. NO menciones las cartas.`;

        } else if (estilo === 'manual') {
            temp = 0.4;
            systemPrompt = `Diccionario técnico de Tarot. Estilo concreto y directo.
${enfoqueTema}

EJEMPLOS PERFECTOS:
- "Persona materialista que se vuelve más sensible."
- "Llega un hombre exitoso y estable."
- "Con tranquilidad, logrará la felicidad familiar."
- "Persona que avanzará decidida y atravesará preocupaciones."

FORMATO:
<div class="reading-section">
    <h3>Dupla 1: Presente</h3>
    <p><strong>Significado:</strong> [2-3 oraciones concretas adaptadas al ${tema}]</p>
    <p><strong>Predicción:</strong> [2 oraciones con verbo de acción futura]</p>
</div>
<div class="reading-section">
    <h3>Dupla 2: Futuro</h3>
    <p><strong>Significado:</strong> [2-3 oraciones con verbos de acción futura adaptadas al ${tema}]</p>
    <p><strong>Predicción:</strong> [3 oraciones]</p>
</div>`;

            userPrompt = esPreguntaEspecifica 
                ? `Pregunta: "${preguntaLimpia}". Cartas: ${a}+${b}, ${c}+${d}. Sé concreto, adapta al tema. Dupla 2 con verbos de acción futura.`
                : `Tema: ${tema}. Cartas: ${a}+${b}, ${c}+${d}. Sé concreto, adapta al tema. Dupla 2 con verbos de acción futura.`;

        } else {
            let personalidad = '';
            if (estilo === 'morgana' || estilo === 'magico') {
                temp = 0.8;
                personalidad = `Eres Morgana, vidente experta. Estilo: místico, predictivo, concreto. Usas palabras directas y verbos de acción futura.`;
            } else {
                temp = 0.6;
                personalidad = `Eres terapeuta experto en Tarot Evolutivo. Estilo: empático, concreto, humano. Describes la evolución de la persona con verbos de acción.`;
            }

            const reglasFormato = `
${enfoqueTema}

REGLAS ABSOLUTAS:
1. Usa palabras CONCRETAS y DIRECTAS.
2. NO uses frases abstractas.
3. Las cartas pueden describir AL CONSULTANTE o a ALGUIEN QUE LLEGA.
4. PROHIBIDO mencionar nombres de cartas.
5. Completa SIEMPRE todas las secciones.
6. **Dupla 2 debe usar verbos de ACCIÓN FUTURA: "avanzará", "logrará", "enfrentará", "superará", "alcanzará".**
7. **PROHIBIDO en Dupla 2: "sigue sintiendo", "se mantiene", "continúa", "permanece".**

FORMATO (3 secciones HTML):
<div class="reading-section">
    <h3>Dupla 1: Tu Presente</h3>
    <p>[2-3 oraciones concretas describiendo a la persona, adaptadas al ${tema}]</p>
</div>
<div class="reading-section">
    <h3>Dupla 2: Tu Evolución Futura</h3>
    <p>[2-3 oraciones con verbos de ACCIÓN FUTURA, adaptadas al ${tema}]</p>
</div>
<div class="reading-section">
    <h3>Conclusión</h3>
    <p><span id="conclusion">[SÍNTESIS CONCRETA de la persona y su evolución en el contexto de ${tema}. Ejemplo: "Persona exitosa que enfrentará desafíos laborales con entusiasmo."]</span></p>
</div>`;

            systemPrompt = personalidad + reglasFormato;
            
            userPrompt = esPreguntaEspecifica 
                ? `Pregunta: "${preguntaLimpia}". Cartas: ${a}+${b}, ${c}+${d}. Sé concreto. Adapta la interpretación al tema de la pregunta. Dupla 2 con verbos de acción futura.`
                : `Tema: ${tema}. Cartas: ${a}+${b}, ${c}+${d}. Sé concreto. Adapta la interpretación al tema de ${tema}. Dupla 2 con verbos de acción futura.`;
        }

        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: MODEL_NAME,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: temp,
                max_tokens: 2400
            })
        });

        const data = await response.json();
        if (!response.ok || !data.choices || data.choices.length === 0) {
            return res.status(500).json({ error: 'Error del proveedor de IA.', detalle: data.error?.message || `HTTP ${response.status}` });
        }

        const raw = data.choices[0].message?.content || '';
        let text = extraerRespuesta(raw);

        if (!text || text.length < 20) {
            text = `<div class="reading-section"><h3>Conclusión</h3><p>Persona en proceso de transformación que avanzará hacia nuevas posibilidades.</p></div>`;
        }

        return res.json({ lectura: text });
    } catch (error) {
        console.error('ERROR:', error.message);
        return res.status(500).json({ error: 'Error interno', detalles: error.message });
    }
});
app.get('/api/admin/clientes', verificarAdmin, async (req, res) => {
    try {
        const clientes = await Usuario.find({}, { __v: 0 }).sort({ createdAt: -1 }).limit(100);
        res.json({ clientes });
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener clientes' });
    }
});

app.post('/api/admin/cambiar-plan', verificarAdmin, async (req, res) => {
    const { userId, nuevoPlan } = req.body;
    if (!userId || !nuevoPlan || !['Gratis', 'Premium'].includes(nuevoPlan)) {
        return res.status(400).json({ error: 'Datos invalidos o plan incorrecto' });
    }
    try {
        const idString = String(userId).trim();
        const filtro = mongoose.Types.ObjectId.isValid(idString) ? { _id: idString } : { email: idString.toLowerCase() };
        const usuario = await Usuario.findOneAndUpdate(filtro, { $set: { plan: nuevoPlan } }, { new: true });
        if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json({ mensaje: `Plan actualizado a ${nuevoPlan}`, usuario });
    } catch (error) {
        res.status(500).json({ error: 'Error al cambiar plan' });
    }
});

app.post('/api/admin/crear-codigo', verificarAdmin, async (req, res) => {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ error: 'Codigo requerido.' });
    try {
        const nuevo = new CodigoPremium({ codigo: codigo.trim().toUpperCase() });
        await nuevo.save();
        res.json({ mensaje: 'Codigo creado', codigo: nuevo });
    } catch (error) {
        if (error.code === 11000) return res.status(400).json({ error: 'Codigo ya existe.' });
        res.status(500).json({ error: 'Error al crear codigo.' });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
