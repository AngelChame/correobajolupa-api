import type { z } from 'zod';
import type { AuthResult, LimitedReason, RuleId } from '../contract/schemas/reports.js';

/**
 * Textos del informe (M3, D-011): plantillas fijas, escritas a mano y revisadas por una persona.
 * Nada se genera en ejecución. Si cambia cualquier texto de este archivo, sube GUIDE_VERSION.
 *
 * Ningún texto lleva enlaces ni direcciones de correo: el informe no debe tener nada clicable (D-017).
 */
export const GUIDE_VERSION = 'g2-2026.11';

export type GuideText = {
  readonly title: string;
  readonly whatItMeans: string;
  readonly whyRisky: string;
  readonly whatToDo: readonly string[];
  readonly forAnalyst: readonly string[];
};

type RuleIdValue = z.infer<typeof RuleId>;

/** Guía por regla: qué significa, por qué es riesgoso, qué hacer y qué revisar (analista). */
export const RULE_GUIDES: Readonly<Record<RuleIdValue, GuideText>> = {
  R1: {
    title: 'Las respuestas irían a otra dirección',
    whatItMeans: 'El correo indica que, al responder, tu mensaje se enviaría a un dominio distinto del que aparece como remitente.',
    whyRisky:
      'Algunos estafadores lo usan para que creas que escribes a una organización conocida mientras tus respuestas llegan a otra persona. También lo hacen servicios legítimos de envío masivo, por eso esta señal sola no prueba nada.',
    whatToDo: [
      'No respondas a este correo.',
      'Si necesitas contactar a la organización, escribe a una dirección que ya conozcas o búscala tú en su sitio oficial.',
      'Si el mensaje te pide datos o pagos, confírmalo por otro medio antes de hacer nada.',
    ],
    forAnalyst: [
      'Compara el dominio del remitente con el de Reply-To en la evidencia.',
      'Revisa si el dominio de Reply-To es de un servicio de envío legítimo conocido.',
      'Si el dominio es sospechoso, valora proponerlo como indicador.',
    ],
  },
  R2: {
    title: 'El enlace dice una cosa y lleva a otra',
    whatItMeans: 'El texto que se ve parece una dirección web, pero el enlace real apunta a otro sitio.',
    whyRisky:
      'Es una forma común de engañar: muestran una dirección de confianza y llevan a una página falsa. Algunos boletines reescriben sus enlaces para medir clics, así que no es una prueba definitiva.',
    whatToDo: [
      'No hagas clic en el enlace.',
      'Si quieres entrar al sitio, escribe tú mismo la dirección o usa un marcador que ya tengas.',
      'Si ya entraste por ese enlace, no escribas contraseñas ni datos personales.',
    ],
    forAnalyst: [
      'Compara el texto visible con el destino en la evidencia (ambos desactivados).',
      'Revisa si el destino pertenece a un servicio de seguimiento de boletines conocido.',
      'No visites el destino: el sistema nunca lo hace.',
    ],
  },
  R3: {
    title: 'Un dominio imita al de tu institución',
    whatItMeans: 'Un dominio del correo se parece mucho a un dominio de la institución, con pequeñas diferencias de letras.',
    whyRisky:
      'Los atacantes registran dominios casi iguales a los reales (por ejemplo, cambiando o agregando una letra) para hacerse pasar por la institución. Un dominio parecido no es el mismo dominio.',
    whatToDo: [
      'No abras enlaces ni descargues archivos de este correo.',
      'No compartas contraseñas ni códigos por correo ni por enlaces de este mensaje.',
      'Si crees que puede ser real, contacta a tu área de soporte por un canal que ya conozcas.',
    ],
    forAnalyst: [
      'Compara el dominio imitado con el institucional en la evidencia.',
      'Valora proponer el dominio imitado como indicador.',
      'Verifica que el dominio institucional configurado esté bien escrito: un error ahí produce falsas alarmas.',
    ],
  },
  R4: {
    title: 'Dominio con caracteres especiales',
    whatItMeans: 'Un enlace usa un dominio con letras fuera del alfabeto inglés básico que pueden parecerse a letras comunes.',
    whyRisky:
      'Algunos caracteres de otros alfabetos se ven igual que una letra normal, y así se puede crear un dominio que parece uno conocido pero es otro. También existen sitios legítimos con acentos u otros alfabetos.',
    whatToDo: [
      'No hagas clic en el enlace.',
      'Compara con calma el dominio con el sitio oficial que conoces.',
      'Si necesitas entrar, escribe tú mismo la dirección del sitio oficial.',
    ],
    forAnalyst: [
      'La evidencia trae el dominio en punycode y en Unicode: compáralos letra por letra.',
      'Si imita a una marca o a la institución, valora proponerlo como indicador.',
      'Un dominio legítimo con acentos es posible: pesa el contexto del resto de las señales.',
    ],
  },
  R5: {
    title: 'El enlace apunta a un número, no a un nombre',
    whatItMeans: 'Un enlace lleva a una dirección IP (números) en lugar de a un nombre de sitio.',
    whyRisky:
      'Los sitios legítimos casi siempre usan nombres. Usar un número ayuda a esquivar las listas de sitios peligrosos y no deja ver a quién pertenece el sitio.',
    whatToDo: [
      'No hagas clic en el enlace.',
      'Si ya entraste, no escribas datos personales ni contraseñas.',
      'Si no esperabas este correo, avisa a tu área de seguridad.',
    ],
    forAnalyst: [
      'Revisa la dirección IP en la evidencia (desactivada); no la visites.',
      'Valora proponer la IP como indicador.',
      'Una IP de red privada o local en un correo externo es todavía más rara: anótalo.',
    ],
  },
  R6: {
    title: 'El enlace usa un tipo de dirección peligroso',
    whatItMeans:
      'Un enlace no es una página web normal: usa un esquema como javascript: o data:, que puede ejecutar instrucciones o incrustar contenido.',
    whyRisky:
      'Estos enlaces pueden ejecutar código o mostrar contenido falso sin abrir un sitio visible. Casi nunca hay un motivo legítimo para encontrarlos en un correo.',
    whatToDo: [
      'No hagas clic en el enlace ni lo copies a la barra de direcciones.',
      'No abras el correo en programas que puedan ejecutarlo.',
      'Elimina el correo o avisa a tu área de seguridad.',
    ],
    forAnalyst: [
      'Revisa el esquema y el enlace original en la evidencia.',
      'Este sistema no ejecuta ni visita enlaces, y muestra el HTML saneado y aislado.',
      'Si el correo llegó a buzones reales, valora avisar al área de seguridad.',
    ],
  },
  R7: {
    title: 'Un adjunto disfraza lo que realmente es',
    whatItMeans:
      'El nombre o el tipo declarado de un adjunto no coincide con su contenido real, o su nombre tiene doble extensión o caracteres que lo invierten.',
    whyRisky:
      'Un programa puede hacerse pasar por un documento (por ejemplo, un archivo que termina en .pdf.exe) para que lo abras. Abrirlo puede ejecutar código en tu equipo.',
    whatToDo: [
      'No abras el archivo adjunto.',
      'No lo reenvíes a otras personas.',
      'Borra el correo o repórtalo; si ya lo abriste, avisa a tu área de seguridad lo antes posible.',
    ],
    forAnalyst: [
      'Compara el tipo declarado, el tipo detectado y el nombre en la evidencia.',
      'El sistema no ejecuta ni descomprime adjuntos; el SHA-256 sirve para buscarlo en fuentes de reputación sin subir el archivo.',
      'Mira el estado de escaneo del adjunto: un error del escáner no significa que esté limpio.',
    ],
  },
  // R8 se activa en M5 (indicadores confirmados); el texto ya está para que el mapa sea completo.
  R8: {
    title: 'Coincide con un indicador confirmado',
    whatItMeans: 'Un elemento de este correo coincide con un indicador que un analista ya confirmó en otro caso.',
    whyRisky:
      'Si un dominio, un remitente o un archivo ya se confirmó como parte de un ataque, este correo podría ser parte del mismo. Es una señal fuerte, no una prueba: la decisión final la toma una persona.',
    whatToDo: ['No abras enlaces ni archivos de este correo.', 'Espera la indicación de tu área de seguridad.'],
    forAnalyst: [
      'Revisa qué indicador coincidió y quién lo confirmó.',
      'Busca mensajes relacionados a partir de ese indicador y decide con la razón de cada candidato.',
    ],
  },
  R9: {
    title: 'Una dirección web presenta señales que conviene revisar',
    whatItMeans: 'La forma de un enlace del correo presenta una o varias señales identificadas por reglas locales.',
    whyRisky:
      'Estas características pueden usarse para ocultar el destino o atraer a alguien a una página falsa. También pueden aparecer en enlaces legítimos: por sí solas no demuestran que el sitio sea peligroso.',
    whatToDo: [
      'No abras el enlace desde el correo si no esperabas el mensaje.',
      'Si necesitas usar ese servicio, entra por una dirección que ya conozcas o por un marcador guardado.',
      'Consulta con tu área de seguridad si el mensaje te pide datos o una acción urgente.',
    ],
    forAnalyst: [
      'Revisa cada señal y su evidencia desactivada; valora el contexto del mensaje.',
      'Contrasta el destino con otras señales antes de proponer un indicador.',
      'No visites el enlace desde el entorno de análisis.',
    ],
  },
  R10: {
    title: 'Una dirección web figura en una lista de reputación',
    whatItMeans: 'El enlace coincide con una dirección publicada en una lista de sitios reportados; la evidencia indica la fuente y la fecha.',
    whyRisky:
      'La aparición en una lista justifica revisarlo con prioridad, pero un reporte de terceros puede equivocarse o quedar desactualizado. La coincidencia por dominio no equivale a una coincidencia exacta de la dirección.',
    whatToDo: [
      'No abras el enlace ni compartas datos a través de él.',
      'Si ya enviaste datos, avisa a tu área de seguridad por un canal conocido.',
      'Espera a que un analista confirme los siguientes pasos.',
    ],
    forAnalyst: [
      'Comprueba en la evidencia la fuente, la fecha y si la coincidencia fue exacta o solo por dominio.',
      'Contrasta la señal con el contexto del correo antes de confirmar un indicador.',
      'Si la lista no está disponible, no interpretes esa falta de datos como una dirección segura.',
    ],
  },
};

/** Texto para una regla que esta guía todavía no explica: el informe no se cae por eso. */
export const UNKNOWN_RULE_GUIDE: GuideText = {
  title: 'Señal detectada',
  whatItMeans: 'El análisis detectó una señal que esta guía todavía no explica.',
  whyRisky: 'Ninguna señal prueba por sí sola que el correo sea malicioso.',
  whatToDo: ['No abras enlaces ni archivos del correo si no lo esperabas.', 'Consulta con tu área de seguridad.'],
  forAnalyst: ['Revisa la evidencia del hallazgo.'],
};

/** Encabezados del resumen (summary.headline). */
export const HEADLINES = {
  failed: 'El análisis no terminó',
  detectedOne: 'Un adjunto coincide con una firma de malware',
  detectedMany: 'Hay adjuntos que coinciden con firmas de malware',
  limitedNoFindings: 'Análisis limitado: sin señales, pero incompleto',
  noFindings: 'No se encontraron señales con las reglas actuales',
  noFindingsUnscanned: 'Sin señales, pero hay adjuntos sin escanear',
  high: 'Se encontraron señales de riesgo importantes',
  medium: 'Se encontraron señales que conviene revisar',
  low: 'Se encontró una señal débil',
} as const;

/**
 * Frases del resumen (summary.text). Las que llevan cantidad son funciones de un número: solo
 * se interpola un entero, nunca texto del correo.
 */
export const SUMMARY_PHRASES = {
  failed:
    'No se pudo terminar el análisis de este correo, así que no hay resultado. Eso no significa que sea seguro: vuelve a subirlo o pide ayuda a un analista.',
  findings: (n: number) => (n === 1 ? 'El análisis encontró 1 señal en este correo.' : `El análisis encontró ${n} señales en este correo.`),
  noRuleProves: 'Ninguna regla prueba por sí sola que sea phishing: lee la guía de cada una antes de decidir.',
  noFindings:
    'Ninguna regla se activó. Esto no significa que el correo sea seguro: las reglas son pocas y un correo malicioso puede no cumplir ninguna.',
  limited: 'El análisis fue limitado: faltó información del correo, así que algunas reglas pudieron no evaluarse.',
  detected: (m: number) =>
    m === 1
      ? 'El escáner antivirus marcó 1 adjunto como malicioso. No lo abras ni lo reenvíes.'
      : `El escáner antivirus marcó ${m} adjuntos como maliciosos. No los abras ni los reenvíes.`,
  scanError: (e: number) =>
    e === 1
      ? '1 adjunto no se pudo escanear por un error del escáner; eso no significa que esté limpio.'
      : `${e} adjuntos no se pudieron escanear por un error del escáner; eso no significa que estén limpios.`,
  unsupported: (u: number) =>
    u === 1
      ? '1 adjunto no se escaneó (tipo o tamaño no soportado); eso no significa que esté limpio.'
      : `${u} adjuntos no se escanearon (tipo o tamaño no soportado); eso no significa que estén limpios.`,
} as const;

type LimitedReasonValue = z.infer<typeof LimitedReason>;
type AuthResultValue = z.infer<typeof AuthResult>;

/** Notas del informe (notes). */
export const NOTE_TEXTS = {
  failed: {
    title: 'El análisis no terminó',
    text: 'No hay resultados de este correo. No significa que sea seguro ni que sea peligroso: significa que no se pudo revisar.',
  },
  limited: {
    title: 'Análisis limitado',
    byReason: {
      missing_headers:
        'El correo no trajo todos sus encabezados (por ejemplo, si se pegó solo el cuerpo). Algunas reglas no pudieron evaluarse, así que la ausencia de señales no quiere decir que sea seguro.',
      parse_error:
        'No se pudo leer todo el correo. Las reglas solo se aplicaron a lo que se pudo leer, así que la ausencia de señales no quiere decir que sea seguro.',
    } satisfies Record<LimitedReasonValue, string>,
  },
  noFindings: {
    title: 'Sin hallazgos no significa seguro',
    text: 'Que ninguna regla se haya activado no demuestra que el correo sea legítimo. Si dudas, no abras enlaces ni archivos y consulta con tu área de seguridad.',
  },
  authInformative: {
    title: 'Autenticación del remitente (informativa)',
    text: (spf: string, dkim: string, dmarc: string) =>
      `Resultados que trae el encabezado: SPF ${spf}, DKIM ${dkim}, DMARC ${dmarc}. Se muestran solo como información: en un archivo subido pueden estar alterados y nunca cambian la prioridad.`,
  },
} as const;

/** Resultado de SPF, DKIM o DMARC en palabras. */
export const AUTH_RESULT_TEXT: Readonly<Record<AuthResultValue, string>> = {
  pass: 'aprobado',
  fail: 'falló',
  none: 'sin registro',
  unknown: 'desconocido',
};
