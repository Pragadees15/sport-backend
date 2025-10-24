import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';

export const validate = (schema: Joi.ObjectSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Log the request body for debugging
    console.log('=== VALIDATION DEBUG ===');
    console.log('Request URL:', req.url);
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    console.log('Request body type:', typeof req.body);
    if (req.body.userId) {
      console.log('userId value:', req.body.userId);
      console.log('userId type:', typeof req.body.userId);
      console.log('userId length:', req.body.userId.length);
    }
    console.log('========================');
    
    const { error, value } = schema.validate(req.body, { abortEarly: false });
    
    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));
      
      console.log('Validation failed for request body:', req.body);
      console.log('Validation errors:', errors);
      console.log('Schema used:', schema.describe());
      
      res.status(400).json({
        success: false,
        error: 'Parameter validation failed',
        details: errors
      });
      return;
    }
    
    // Use validated value with defaults applied
    req.body = value;
    
    next();
  };
};

export const validateQuery = (schema: Joi.ObjectSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Extend schema to allow cache buster parameter
    const extendedSchema = schema.keys({
      _t: Joi.number().optional() // Cache buster parameter
    });
    
    const { error } = extendedSchema.validate(req.query, { abortEarly: false });
    
    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));
      
      res.status(400).json({
        success: false,
        error: 'Query validation failed',
        details: errors
      });
      return;
    }
    
    next();
  };
};

export const validateParams = (schema: Joi.ObjectSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const { error } = schema.validate(req.params, { abortEarly: false });
    
    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));
      
      res.status(400).json({
        success: false,
        error: 'Parameter validation failed',
        details: errors
      });
      return;
    }
    
    next();
  };
};