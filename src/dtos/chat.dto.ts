import { z } from 'zod';

export const RegisterSchema = z.object({
  email: z.string().email('Correo inválido'),
  password: z.string().min(12, 'La contraseña necesita al menos 12 caracteres'),
  fullName: z.string().min(2, 'El nombre necesita al menos 2 caracteres').max(150),
});
export type RegisterDto = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: z.string().email('Correo inválido'),
  password: z.string().min(1, 'Falta la contraseña'),
});
export type LoginDto = z.infer<typeof LoginSchema>;

export const RefreshSchema = z.object({
  refreshToken: z.string().min(10, 'Falta el token'),
});
export type RefreshDto = z.infer<typeof RefreshSchema>;

export const CreateConversationSchema = z.object({
  model: z.string().min(1).max(80).optional(),
  systemPrompt: z.string().max(4000).optional(),
  title: z.string().min(1).max(200).optional(),
});
export type CreateConversationDto = z.infer<typeof CreateConversationSchema>;

export const UpdateConversationSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => v.title !== undefined || v.archived !== undefined, {
    message: 'No hay nada que cambiar',
  });
export type UpdateConversationDto = z.infer<typeof UpdateConversationSchema>;

export const SendMessageSchema = z.object({
  content: z.string().min(1, 'El mensaje viene vacío').max(20_000),
});
export type SendMessageDto = z.infer<typeof SendMessageSchema>;

export const DemoSessionSchema = z.object({
  role: z.enum(['usuario', 'administrador']),
});
export type DemoSessionDto = z.infer<typeof DemoSessionSchema>;
