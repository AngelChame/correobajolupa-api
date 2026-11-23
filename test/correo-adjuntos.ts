// Correo sintético con adjuntos para las pruebas de M2. Contenidos armados en la prueba: ningún
// binario real en el repositorio.

export type Parte = { name?: string; type: string; content: Buffer };

/** Correo multipart/mixed con los adjuntos dados (base64). */
export function correoConAdjuntos(partes: Parte[]): Buffer {
  const lineas = [
    'From: remitente@servicio-ejemplo.example',
    'To: persona@universidad-ejemplo.example',
    'Subject: Documentos',
    'Date: Mon, 23 Nov 2026 10:00:00 -0600',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="LIMITE"',
    '',
    '--LIMITE',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Adjunto los documentos.',
  ];
  for (const p of partes) {
    lineas.push('--LIMITE', `Content-Type: ${p.type}`, 'Content-Transfer-Encoding: base64');
    if (p.name !== undefined) lineas.push(`Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(p.name)}`);
    else lineas.push('Content-Disposition: attachment');
    lineas.push('', p.content.toString('base64'));
  }
  lineas.push('--LIMITE--', '');
  return Buffer.from(lineas.join('\r\n'));
}
