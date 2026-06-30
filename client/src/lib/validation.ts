/**
 * Client-side zod schemas mirroring the backend validation
 * (server/api/src/schemas/*.ts). These give instant feedback; the server stays
 * the source of truth and re-validates everything.
 */

import { z } from "zod";
import { LIMITS, RESERVED_ALIASES } from "./config";

export const loginSchema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export const registerSchema = z
  .object({
    email: z.string().min(1, "Email is required").email("Enter a valid email"),
    password: z
      .string()
      .min(LIMITS.passwordMin, `At least ${LIMITS.passwordMin} characters`)
      .max(LIMITS.passwordMax, `At most ${LIMITS.passwordMax} characters`)
      .regex(/[A-Z]/, "Add an uppercase letter")
      .regex(/[a-z]/, "Add a lowercase letter")
      .regex(/[0-9]/, "Add a number"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

const reservedSet = new Set<string>(RESERVED_ALIASES);

export const createUrlSchema = z.object({
  url: z
    .string()
    .min(1, "URL is required")
    .max(LIMITS.urlMax, `At most ${LIMITS.urlMax} characters`)
    .refine((value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    }, "Enter a valid http(s) URL"),
  customAlias: z
    .string()
    .trim()
    .regex(
      /^[a-zA-Z0-9-]{3,50}$/,
      `${LIMITS.aliasMin}–${LIMITS.aliasMax} letters, numbers or hyphens`,
    )
    .refine((value) => !reservedSet.has(value.toLowerCase()), "That alias is reserved")
    .optional()
    .or(z.literal("")),
  ttlDays: z
    .number()
    .int("Whole days only")
    .min(LIMITS.ttlMinDays, `At least ${LIMITS.ttlMinDays} day`)
    .max(LIMITS.ttlMaxDays, `At most ${LIMITS.ttlMaxDays} days`)
    .optional(),
});

export type LoginValues = z.infer<typeof loginSchema>;
export type RegisterValues = z.infer<typeof registerSchema>;
export type CreateUrlValues = z.infer<typeof createUrlSchema>;
