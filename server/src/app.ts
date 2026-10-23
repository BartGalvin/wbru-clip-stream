import express, { type ErrorRequestHandler, type Express } from 'express';
import { isRequestBody } from './httpValidation';
import { createProgramRouter } from './routes/program';
import { createTagsRouter } from './routes/tags';

// express.json marks malformed bodies with an entity.* error type.
function isClientBodyError(error: unknown): boolean {
  return (
    isRequestBody(error) &&
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500 &&
    typeof error.type === 'string' &&
    error.type.startsWith('entity.')
  );
}

// Return useful client errors without exposing unexpected server failures.
const errorBoundary: ErrorRequestHandler = (error, _req, res, next) => {
  if (isClientBodyError(error)) {
    res.status(400).json({ error: 'invalid request body' });
    return;
  }

  console.error('Unhandled request error', error);
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: 'internal server error' });
};

// Assemble the public program API, operator API, and final error boundary.
export function createApp(): Express {
  const app = express();
  // A bulk metadata edit may include every clip in the catalog.
  app.use(express.json({ limit: '5mb' }));
  app.use(createProgramRouter());
  app.use(createTagsRouter());
  app.use(errorBoundary);
  return app;
}
