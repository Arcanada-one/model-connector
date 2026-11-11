/**
 * Server-selected protected Lab reservation routes (stage A).
 *
 * Enabled only when PROTECTED_LAB_PROFILE is true. A client body flag cannot
 * select or downgrade this profile — these routes alone set protectedProfile.
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';

import {
  IDEMPOTENCY_HEADER,
  InvalidIdempotencyKeyError,
  normalizeIdempotencyKey,
} from '../billing/intent';
import { ConnectorsService } from './connectors.service';
import { ConnectorResponse } from './interfaces/connector.interface';
import { perConnectorExecuteSchema, PerConnectorExecuteDto } from './dto/execute.dto';

interface AuthenticatedRequest extends FastifyRequest {
  apiKey?: { id: string };
}

const prepareBodySchema = z.object({
  // Optional client hint only. Server derives the authoritative revision from
  // the catalogue; a provided value must equal the server pin or prepare refuses.
  pricePolicyRevision: z.string().min(1).max(200).optional(),
});

const executeProtectedExtraSchema = z.object({
  reservationRef: z.string().uuid(),
});

/** Client flags that must not select or collide with DTO fields (e.g. profile). */
const executeClientFlagSchema = z.object({
  protected: z.unknown().optional(),
  profile: z.unknown().optional(),
});

type PrepareDto = PerConnectorExecuteDto & z.infer<typeof prepareBodySchema>;
type ExecuteProtectedDto = PerConnectorExecuteDto & z.infer<typeof executeProtectedExtraSchema>;

/** Compose per-connector execute schema with protected extras (superRefine-safe). */
function parsePrepareBody(raw: unknown): PrepareDto {
  try {
    const base = perConnectorExecuteSchema.parse(raw);
    const extra = prepareBodySchema.parse(raw);
    return { ...base, ...extra };
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpException(
        { error: 'validation_error', message: err.issues[0]?.message ?? 'invalid body' },
        HttpStatus.BAD_REQUEST,
      );
    }
    throw err;
  }
}

function parseExecuteProtectedBody(raw: unknown): ExecuteProtectedDto {
  try {
    const base = perConnectorExecuteSchema.parse(raw);
    const extra = executeProtectedExtraSchema.parse(raw);
    // Parse-and-discard: accept client flags without merging them into the DTO
    // (they would collide with PerConnectorExecuteDto.profile typing).
    executeClientFlagSchema.parse(raw);
    return { ...base, reservationRef: extra.reservationRef };
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpException(
        { error: 'validation_error', message: err.issues[0]?.message ?? 'invalid body' },
        HttpStatus.BAD_REQUEST,
      );
    }
    throw err;
  }
}

function parseIdempotencyKey(raw: string | undefined): string | undefined {
  try {
    return normalizeIdempotencyKey(raw) ?? undefined;
  } catch (err) {
    if (err instanceof InvalidIdempotencyKeyError) {
      throw new HttpException(
        { error: 'validation_error', message: err.message },
        HttpStatus.BAD_REQUEST,
      );
    }
    throw err;
  }
}

@Controller()
export class ProtectedLabController {
  constructor(private readonly connectorsService: ConnectorsService) {}

  private requireEnabled(connectorName: string): void {
    if (!this.connectorsService.isProtectedLabProfileEnabled()) {
      throw new HttpException(
        {
          error: 'protected_profile_disabled',
          message: 'Protected Lab profile is not enabled on this server.',
        },
        HttpStatus.NOT_FOUND,
      );
    }
    // Fail-closed: an empty / unset allow-list admits no connector.
    const allowed = this.connectorsService.protectedLabConnectors();
    if (!allowed.has(connectorName)) {
      throw new HttpException(
        {
          error: 'protected_connector_not_admitted',
          message: `Connector '${connectorName}' is not admitted to the protected Lab profile.`,
        },
        HttpStatus.FORBIDDEN,
      );
    }
    // Allow-list alone is not enough — the connector must declare and implement
    // the dispatch fence (BaseApiConnector path today).
    if (!this.connectorsService.connectorSupportsProtectedDispatchFence(connectorName)) {
      throw new HttpException(
        {
          error: 'protected_connector_unfenced',
          message: `Connector '${connectorName}' does not support the protected dispatch fence.`,
        },
        HttpStatus.FORBIDDEN,
      );
    }
  }

  @Post('connectors/:name/protected/reservations')
  async prepare(
    @Param('name') name: string,
    @Body() rawBody: unknown,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    this.requireEnabled(name);
    const body = parsePrepareBody(rawBody);
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    const key = parseIdempotencyKey(idempotencyKey);
    const result = await this.connectorsService.prepareProtectedReservation(
      name,
      { ...body, idempotencyKey: key },
      apiKeyId,
      body.pricePolicyRevision,
    );

    if (result.outcome === 'opened') {
      return {
        reservation_ref: result.reservation.reservationRef,
        binding: result.reservation,
      };
    }
    if (result.outcome === 'insufficient') {
      throw new HttpException(
        {
          error: 'credit_depleted',
          balanceUsd: result.balanceUsd,
          requiredUsd: result.requiredUsd,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    if (result.outcome === 'refused') {
      throw new HttpException(
        { error: result.code, message: result.message },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (result.outcome === 'payload_mismatch') {
      throw new HttpException(
        {
          error: 'idempotency_key_reused',
          message: 'Operation key reused with a different payload.',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (result.outcome === 'protected_unknown') {
      throw new HttpException(
        {
          error: 'protected_unknown',
          message:
            'A prior protected attempt under this key committed dispatch or is unknown; not reclaimable.',
        },
        HttpStatus.CONFLICT,
      );
    }
    if (result.outcome === 'in_flight') {
      throw new HttpException(
        { error: 'idempotency_conflict', message: 'Reservation is still in flight.' },
        HttpStatus.CONFLICT,
      );
    }
    if (result.outcome === 'integrity_refused') {
      throw new HttpException(
        {
          error: result.reason,
          message:
            'Protected settled result failed retained integrity verification; no disclosure.',
        },
        HttpStatus.CONFLICT,
      );
    }
    if (result.outcome === 'replay') {
      // Settled-replay byte return unchanged: integrity is one input to P10,
      // not a read grant (Auth entitlement remains P10-01..04).
      return { replay: true, response: result.response, requestId: result.requestId };
    }
    throw new HttpException(
      { error: 'idempotency_replay_unavailable', message: 'Completed but not replayable.' },
      HttpStatus.CONFLICT,
    );
  }

  @Get('connectors/:name/protected/reservations/:ref')
  async lookup(
    @Param('name') name: string,
    @Param('ref') reservationRef: string,
    @Req() req: AuthenticatedRequest,
  ) {
    this.requireEnabled(name);
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    const looked = await this.connectorsService.lookupProtectedReservation(
      reservationRef,
      apiKeyId,
    );
    if (looked.outcome === 'not_found') {
      throw new HttpException(
        { error: 'protected_reservation_mismatch', message: 'reservation_ref not found.' },
        HttpStatus.NOT_FOUND,
      );
    }
    if (looked.outcome === 'forbidden') {
      throw new HttpException(
        {
          error: 'protected_reservation_forbidden',
          message: 'reservation_ref not bound to this key.',
        },
        HttpStatus.FORBIDDEN,
      );
    }
    if (looked.reservation.providerName && looked.reservation.providerName !== name) {
      throw new HttpException(
        {
          error: 'protected_reservation_mismatch',
          message: 'reservation_ref bound to another connector.',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return { reservation_ref: looked.reservation.reservationRef, binding: looked.reservation };
  }

  @Post('connectors/:name/protected/execute')
  async execute(
    @Param('name') name: string,
    @Body() rawBody: unknown,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    this.requireEnabled(name);
    const body = parseExecuteProtectedBody(rawBody);
    const apiKeyId = req.apiKey?.id ?? 'unknown';
    const key = parseIdempotencyKey(idempotencyKey);
    // Client `protected`/`profile` flags were parse-and-discarded above. Drop the
    // DTO `profile` field too — the route owns the protected Lab profile.
    const { profile: _clientProfile, reservationRef, ...rest } = body;
    const response = await this.connectorsService.execute(
      name,
      {
        ...(rest as PerConnectorExecuteDto),
        idempotencyKey: key,
        reservationRef,
        protectedProfile: true,
      },
      apiKeyId,
    );
    return this.mapResponseStatus(response);
  }

  private mapResponseStatus(response: ConnectorResponse) {
    if (response.status === 'success') {
      return Object.assign(response, { statusCode: HttpStatus.CREATED });
    }
    const type = response.error?.type ?? 'error';
    const status =
      type === 'credit_depleted'
        ? HttpStatus.PAYMENT_REQUIRED
        : type === 'protected_reservation_forbidden'
          ? HttpStatus.FORBIDDEN
          : type === 'protected_unknown' || type === 'idempotency_conflict'
            ? HttpStatus.CONFLICT
            : type.startsWith('protected_')
              ? HttpStatus.BAD_REQUEST
              : HttpStatus.BAD_GATEWAY;
    throw new HttpException(response, status);
  }
}
