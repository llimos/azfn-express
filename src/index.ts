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
import type { response, Application } from 'express';
import type { OutgoingHttpHeaders } from 'node:http';

declare module "node:http" {
    interface IncomingMessage {
        context: InvocationContext;
        user: HttpRequestUser | null;
    }
    interface ServerResponse<Request extends IncomingMessage = IncomingMessage> {
        _headerSent: boolean; // Exists in implementation
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
         // It's not actually a `response` yet, but Express will swap the prototype
         const res = new ServerResponse(req).on('error', reject) as typeof response;

         // Readable stream to return to Azure
         let responseStreamController: ReadableStreamController<Buffer>;

         // Override the part that actually sends the data, to send it to Azure instead
         res.write = function write(
            this: typeof response,
            data,
            encoding?: BufferEncoding | undefined | ((error?: Error | null | undefined) => void),
            callback?: (error?: Error | null | undefined) => void,
         ) {
            // This is from the original function
            if (typeof encoding === 'function') {
               callback = encoding;
               encoding = undefined;
            }

            // If there's no data, don't do anything
            if (data) {
               // Return the response to Azure including the body as a stream
               if (!responseStreamController) {
                  // Return to Azure immediately
                  // If there is a response body, it will be streamed
                  resolve(
                     new HttpResponse({
                        status: this.statusCode,
                        headers: mapHeaders(this.getHeaders()),
                        body: new ReadableStream<Buffer>({
                           start: controller => responseStreamController = controller
                        }),
                     }),
                  );

                  // Internal property; might be used somewhere else
                  this._headerSent = true;
               }

               // Write the data
               responseStreamController.enqueue(data);
            }

            // Confirm that the data has been processed
            callback?.();

            return true;
         };

         res.end = function end(
            this: typeof response,
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

            if (!responseStreamController) {
               // This is the first and only chunk, don't bother with streams
               resolve({
                  status: this.statusCode,
                  headers: mapHeaders(this.getHeaders()),
                  body: data || null // Handle it being ''. It won't be 0.
               });

               this._headerSent = true;

            } else {
               // This is not the first chunk. Write the chunk and close the stream
               if (data) {
                  responseStreamController.enqueue(data);
               }

               responseStreamController.close();
               
            }

            callback?.();

            // Emit Express events
            this.emit('finish');
            this.emit('close');

            // Return `this` to allow chaining, like in Express
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

function mapHeaders(expressHeaders: OutgoingHttpHeaders): Headers {
   const headers = new Headers;
   for (const [k, v] of Object.entries(expressHeaders)) {
      if (Array.isArray(v)) {
         for (const e of v) {
            headers.append(k, e);
         }
      } else if (v) {
         headers.set(k, String(v));
      }
   }
   return headers;
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