/**
 * Archivo de prueba EICAR, armado en memoria al ejecutar la prueba (D-037).
 * La cadena completa NUNCA aparece en el repositorio: va partida en pedazos que no son la firma
 * por separado. No es malware: es el archivo estándar que los antivirus detectan a propósito.
 */
const PEDAZOS = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STAN', 'DARD-ANTIVIRUS-TE', 'ST-FILE!$H+H*'];

export function eicar(): Buffer {
  return Buffer.from(PEDAZOS.join(''), 'latin1');
}

/** Marca para que el clamd falso reconozca el contenido sin guardar la cadena entera aquí. */
export function esEicar(content: Buffer): boolean {
  return content.equals(eicar());
}
