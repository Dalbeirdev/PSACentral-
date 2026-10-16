import { applyDecorators, BadRequestException, type PipeTransform } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

export class ValidationFailedException extends BadRequestException {
  constructor(public readonly issues: { path: string; message: string }[]) {
    super('Request validation failed');
  }
}

/** Validates and transforms input with a zod schema from @psacc/contracts. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new ValidationFailedException(
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return result.data;
  }
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
}

/** Documents a zod request body in OpenAPI. Validation itself is done by ZodPipe. */
export const ApiZodBody = (schema: z.ZodType) => ApiBody({ schema: jsonSchema(schema) as never });

/** Documents each property of a zod object schema as an OpenAPI query parameter. */
export function ApiZodQuery(schema: z.ZodObject) {
  const js = jsonSchema(schema) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  const decorators = Object.entries(js.properties ?? {}).map(([name, prop]) =>
    ApiQuery({ name, required: js.required?.includes(name) ?? false, schema: prop as never }),
  );
  return applyDecorators(...decorators);
}
