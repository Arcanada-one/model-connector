import { Module } from '@nestjs/common';
import { CartesiaClient } from './cartesia-client';

export const CARTESIA_HTTP_PORT = Symbol('CARTESIA_HTTP_PORT');
export const CARTESIA_WEBSOCKET_PORT = Symbol('CARTESIA_WEBSOCKET_PORT');
export const CARTESIA_CONFIG = Symbol('CARTESIA_CONFIG');

@Module({})
export class CartesiaModule {
  static readonly client = CartesiaClient;
}
