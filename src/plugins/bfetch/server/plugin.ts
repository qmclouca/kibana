/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import type {
  CoreStart,
  PluginInitializerContext,
  CoreSetup,
  Plugin,
  Logger,
  KibanaRequest,
  RouteMethod,
  RequestHandler,
  RequestHandlerContext,
  StartServicesAccessor,
} from 'src/core/server';
import { schema } from '@kbn/config-schema';
import { map$ } from '@kbn/std';
import {
  StreamingResponseHandler,
  BatchRequestData,
  BatchResponseItem,
  ErrorLike,
  removeLeadingSlash,
  normalizeError,
} from '../common';
import { StreamingRequestHandler } from './types';
import { createStream } from './streaming';
import { getUiSettings } from './ui_settings';

// eslint-disable-next-line
export interface BfetchServerSetupDependencies {}

// eslint-disable-next-line
export interface BfetchServerStartDependencies {}

export interface BatchProcessingRouteParams<BatchItemData, BatchItemResult> {
  onBatchItem: (data: BatchItemData) => Promise<BatchItemResult>;
}

/** @public */
export interface BfetchServerSetup {
  addBatchProcessingRoute: <BatchItemData extends object, BatchItemResult extends object>(
    path: string,
    handler: (request: KibanaRequest) => BatchProcessingRouteParams<BatchItemData, BatchItemResult>
  ) => void;
  addStreamingResponseRoute: <Payload, Response>(
    path: string,
    params: (request: KibanaRequest) => StreamingResponseHandler<Payload, Response>
  ) => void;
  /**
   * Create a streaming request handler to be able to use an Observable to return chunked content to the client.
   * This is meant to be used with the `fetchStreaming` API of the `bfetch` client-side plugin.
   *
   * @example
   * ```ts
   * setup({ http }: CoreStart, { bfetch }: SetupDeps) {
   *   const router = http.createRouter();
   *   router.post(
   *   {
   *     path: '/api/my-plugin/stream-endpoint,
   *     validate: {
   *       body: schema.object({
   *         term: schema.string(),
   *       }),
   *     }
   *   },
   *   bfetch.createStreamingResponseHandler(async (ctx, req) => {
   *     const { term } = req.body;
   *     const results$ = await myApi.getResults$(term);
   *     return results$;
   *   })
   * )}
   *
   * ```
   *
   * @param streamHandler
   */
  createStreamingRequestHandler: <
    Response,
    P,
    Q,
    B,
    Context extends RequestHandlerContext = RequestHandlerContext,
    Method extends RouteMethod = any
  >(
    streamHandler: StreamingRequestHandler<Response, P, Q, B, Method>
  ) => RequestHandler<P, Q, B, Context, Method>;
}

// eslint-disable-next-line
export interface BfetchServerStart {}

const streamingHeaders = {
  'Content-Type': 'application/x-ndjson',
  Connection: 'keep-alive',
  'Transfer-Encoding': 'chunked',
};

export class BfetchServerPlugin
  implements
    Plugin<
      BfetchServerSetup,
      BfetchServerStart,
      BfetchServerSetupDependencies,
      BfetchServerStartDependencies
    > {
  constructor(private readonly initializerContext: PluginInitializerContext) {}

  public setup(core: CoreSetup, plugins: BfetchServerSetupDependencies): BfetchServerSetup {
    const logger = this.initializerContext.logger.get();
    const router = core.http.createRouter();

    core.uiSettings.register(getUiSettings());

    const addStreamingResponseRoute = this.addStreamingResponseRoute({
      getStartServices: core.getStartServices,
      router,
      logger,
    });
    const addBatchProcessingRoute = this.addBatchProcessingRoute(addStreamingResponseRoute);
    const createStreamingRequestHandler = this.createStreamingRequestHandler({
      getStartServices: core.getStartServices,
      logger,
    });

    return {
      addBatchProcessingRoute,
      addStreamingResponseRoute,
      createStreamingRequestHandler,
    };
  }

  public start(core: CoreStart, plugins: BfetchServerStartDependencies): BfetchServerStart {
    return {};
  }

  public stop() {}

  private getCompressionDisabled(request: KibanaRequest) {
    return request.headers['x-chunk-encoding'] !== 'deflate';
  }

  private addStreamingResponseRoute = ({
    getStartServices,
    router,
    logger,
  }: {
    getStartServices: StartServicesAccessor;
    router: ReturnType<CoreSetup['http']['createRouter']>;
    logger: Logger;
  }): BfetchServerSetup['addStreamingResponseRoute'] => (path, handler) => {
    router.post(
      {
        path: `/${removeLeadingSlash(path)}`,
        validate: {
          body: schema.any(),
        },
      },
      async (context, request, response) => {
        const handlerInstance = handler(request);
        const data = request.body;
        const compressionDisabled = this.getCompressionDisabled(request);
        return response.ok({
          headers: streamingHeaders,
          body: createStream(handlerInstance.getResponseStream(data), logger, compressionDisabled),
        });
      }
    );
  };

  private createStreamingRequestHandler = ({
    logger,
    getStartServices,
  }: {
    logger: Logger;
    getStartServices: StartServicesAccessor;
  }): BfetchServerSetup['createStreamingRequestHandler'] => (streamHandler) => async (
    context,
    request,
    response
  ) => {
    const response$ = await streamHandler(context, request);
    const compressionDisabled = this.getCompressionDisabled(request);
    return response.ok({
      headers: streamingHeaders,
      body: createStream(response$, logger, compressionDisabled),
    });
  };

  private addBatchProcessingRoute = (
    addStreamingResponseRoute: BfetchServerSetup['addStreamingResponseRoute']
  ): BfetchServerSetup['addBatchProcessingRoute'] => <
    BatchItemData extends object,
    BatchItemResult extends object,
    E extends ErrorLike = ErrorLike
  >(
    path: string,
    handler: (request: KibanaRequest) => BatchProcessingRouteParams<BatchItemData, BatchItemResult>
  ) => {
    addStreamingResponseRoute<
      BatchRequestData<BatchItemData>,
      BatchResponseItem<BatchItemResult, E>
    >(path, (request) => {
      const handlerInstance = handler(request);
      return {
        getResponseStream: ({ batch }) =>
          map$(batch, async (batchItem, id) => {
            try {
              const result = await handlerInstance.onBatchItem(batchItem);
              return { id, result };
            } catch (error) {
              return { id, error: normalizeError<E>(error) };
            }
          }),
      };
    });
  };
}
