import { z } from 'zod';
import { Role } from './common.js';

export const User = z
  .object({
    id: z.uuid(),
    email: z.email(),
    displayName: z.string(),
    role: Role,
    active: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'User' });

export const Session = z
  .object({
    user: User,
    csrfToken: z.string().meta({ description: 'Se envía en la cabecera `X-CSRF-Token` de las peticiones que modifican datos.' }),
  })
  .meta({ id: 'Session' });

export const RegisterBody = z
  .object({
    email: z.email(),
    password: z.string().min(12).max(128),
    displayName: z.string().min(1).max(80),
    inviteCode: z.string().max(64).optional().meta({ description: 'Código de invitación opcional (D-010).' }),
  })
  .meta({ id: 'RegisterBody' });

export const LoginBody = z
  .object({
    email: z.email(),
    password: z.string().min(1).max(128),
  })
  .meta({ id: 'LoginBody' });

export const UpdateUserBody = z
  .object({
    role: Role.optional(),
    active: z.boolean().optional(),
  })
  .meta({ id: 'UpdateUserBody', description: 'Al cambiar el rol o desactivar la cuenta se cierran sus sesiones.' });

export const UserList = z
  .object({
    items: z.array(User),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .meta({ id: 'UserList' });
