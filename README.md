# azfn-express
This package allows you to expose an [ExpressJS](https://expressjs.com) application as a serverless app using Azure Functions.

All Express routing and middleware is supported. A single Azure function handles your entire API.

Using the new v4 programming model, natively streamed requests and responses are also supported, just as if you were using standalone Express.

## Requirements
* Your Azure Functions app is using the new v4 programming model

## Quick Start
1. Add this package to your app: 
`yarn add azfn-express` or `npm install azfn-express`
2. Use the `register` function to register your Express application with Azure Functions. Make sure the file this is in gets imported eventually from your `main` entrypoint.
```ts
import { register } from 'azfn-express';
import { myExpressApp } from './app';

register(myExpressApp);
```
This will register your app with sensible defaults, as well as enable HTTP Streaming in your Azure app. A function called 'Api' will be created, that will handle all incoming requests.

*Note:* By default, Azure Functions has a base URL path of `/api`. The adapter does **not** strip this out, so your Express app routing needs to take the prefix into account.

## Detailed Instructions
For more customization, you may provide the name of the app, or a configuration object that will be passed straight to the Azure registration function, or both.
```ts
register(myExpressApp, 'MyApi', {route: '/myapi/{*segments}'})
```
```ts
register(myExpressApp, {
    methods: ['GET'], 
    authLevel: 'function'
});
```
For even more control, instead of using `register`, you can use `createHandler` which will return the handler function for you to register yourself.
```ts
import { app } from '@azure/functions';
import { createHandler } from 'azfn-express';
import { myExpressApp } from './app';

app.setup({ enableHttpStream: true })
app.http('MyApi', {
    handler: createHandler(myExpressApp),
    route: '{*segments}'
});
```

## Inside Express
Request bodies are always provided to Express as a raw stream only. You will need to add Express middlewares for parsing JSON and so on. This package does not use the internal Azure methods for body parsing.

Two extra properties will be available on the Express request object:
* `context` - this is the Azure Functions invocation context, used for logging and so on
* `user` - if using Azure authentication, this will be the user object, if there is one

See the Express documentation for how to handle streaming requests and responses, if you wish to do so. You may also use the Express `send` method, or any other Express functionality.