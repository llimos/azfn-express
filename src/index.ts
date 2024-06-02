import { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { ReadableStream, ReadableStreamController } from 'node:stream/web';
import {
    app,
    HttpResponse,
    HttpFunctionOptions,
    type HttpHandler,
    type HttpRequest,
    type HttpResponseInit,
    type InvocationContext,
    HttpRequestUser,
} from '@azure/functions';
import type { Application } from 'express';


declare module "node:http" {
    interface IncomingMessage {
        context: InvocationContext;
        user: HttpRequestUser | null;
    }
    interface ServerResponse<Request extends IncomingMessage = IncomingMessage> {
        _headerSent: boolean;
    }
}

export function createExpressHandler(app: Application): HttpHandler {
   return function expressHandler(
      request: HttpRequest,
      context: InvocationContext,
   ): Promise<HttpResponseInit> {
      return new Promise((resolve, reject) => {
         // Create an IncomingMessage for Express, with the request body as the stream
         let req: IncomingMessage;
         if (request.body)
            req = Object.setPrototypeOf(
               Readable.fromWeb(request.body),
               IncomingMessage.prototype,
            );
         else {
            //@ts-ignore Typings don't allow null socket but it does work
            req = new IncomingMessage(null);
            req.push(null);
         }
         req.on('error', reject);
         req.method = request.method;
         req.headers = Object.fromEntries(request.headers.entries());
         req.url = request.url;
         req.user = request.user;
         // Add Azure context
         req.context = context;

         // Create a ServerResponse for Express
         const res = new ServerResponse(req).on('error', reject);

         // Readable stream to return to Azure
         let responseStreamController: ReadableStreamController<Buffer>;

         // Override the part that actually sends the data, to send it to Azure instead
         // We need to override both of these - `write` is used for streaming and `_send` for Express's `send`
         res.write = function write(
            this: ServerResponse,
            data,
            encoding?: BufferEncoding | undefined | ((error?: Error | null | undefined) => void),
            callback?: (error?: Error | null | undefined) => void,
         ) {
            // This is from the original function
            if (typeof encoding === 'function') {
               callback = encoding;
               encoding = undefined;
            }

            // When Express decides to write the headers, return the response to Azure including the body as a stream
            if (!this._headerSent) {
               // Return to Azure immediately
               // If there is a response body, it will be streamed
               resolve(
                  new HttpResponse({
                     status: this.statusCode,
                     headers: this.getHeaders() as Record<
                        string,
                        string | string[]
                     >,
                     body: data
                        ? new ReadableStream<Buffer>({
                             start: controller =>
                                (responseStreamController = controller),
                          })
                        : null,
                  }),
               );

               this._headerSent = true;
            }

            // Write the data, if any
            if (data) {
               responseStreamController.enqueue(data);
            }

            // Confirm that the data has been processed
            callback?.();

            return true;
         };

         res.end = function end(
            this: ServerResponse,
            data?,
            encoding?: BufferEncoding | ((error?: Error | null | undefined) => void),
            callback?: (error?: Error | null | undefined) => void,
         ) {
            if (typeof data === 'function') {
               callback = data;
               data = null;
               encoding = undefined;
            } else if (typeof encoding === 'function') {
               callback = encoding;
               encoding = undefined;
            }

            this.write(data, encoding as BufferEncoding);
            responseStreamController?.close();

            callback?.();

            return this;
         };

         // Process the request
         try {
            app(req, res);
         } catch (e) {
            reject(e);
         }
      });
   };
}


type Options = Omit<HttpFunctionOptions, 'handler'>;
export function register(expressApp: Application, name?: string, options?: Options): void;
export function register(expressApp: Application, options: Options): void;
export function register(expressApp: Application, name?: string | Options, options?: Options): void {
    if (typeof name !== 'string') {
      // `name` is actually `options` - call again with default name
      return register(expressApp, 'Api', name);
    }

   // Default options which can be overridden, and handler which cannot
   const defaultOptions: Options = {
      route: '{*segments}',
      // Azure docs claim it defaults to all methods, but actually it only defaults to ['GET', 'POST']
      methods: ['CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE']
   }
    const mergedOptions: HttpFunctionOptions = Object.assign(
      defaultOptions, options, { handler: createExpressHandler(expressApp) }
    );

    app.setup({ enableHttpStream: true });
    app.http(name, mergedOptions)
}