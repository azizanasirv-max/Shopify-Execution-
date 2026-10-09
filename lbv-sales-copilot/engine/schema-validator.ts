/**
 * Runtime Tool Argument Schema Validator
 *
 * Enforces fail-closed schema validation on all model-generated tool calls
 * before any business operation can reach an adapter's executeTool method.
 *
 * Rules:
 * 1. Rejects unknown tool names before execution.
 * 2. Rejects unexpected properties where the tool declares no arguments or strict properties.
 * 3. Rejects incorrect argument types (string, number, boolean, array, object).
 * 4. Rejects missing required properties.
 * 5. Rejects invalid enum values.
 * 6. Handles tools with no arguments consistently and securely.
 */

import { ToolDefinition } from "./types.js";

export interface SchemaValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates model-generated tool arguments against the declared ToolDefinition.
 */
export function validateToolCall(
  toolDef: ToolDefinition | undefined,
  callArgs: any
): SchemaValidationResult {
  // 1. Tool existence check
  if (!toolDef) {
    return {
      valid: false,
      error: "Unauthorized tool call: The requested tool is not declared or permitted by the active Sales API."
    };
  }

  const declaredParams = toolDef.parameters;
  const declaredProps = declaredParams?.properties || {};
  const requiredKeys = declaredParams?.required || [];
  const hasDeclaredProperties = Object.keys(declaredProps).length > 0;

  // 2. Case: Tool takes NO arguments (properties is empty or undefined)
  if (!hasDeclaredProperties && requiredKeys.length === 0) {
    if (callArgs === null || callArgs === undefined) {
      return { valid: true };
    }

    if (typeof callArgs !== "object" || Array.isArray(callArgs)) {
      return {
        valid: false,
        error: `Invalid arguments for tool '${toolDef.name}': Expected empty object or no parameters, received non-object.`
      };
    }

    const providedKeys = Object.keys(callArgs);
    if (providedKeys.length > 0) {
      return {
        valid: false,
        error: `Unexpected arguments for tool '${toolDef.name}': This tool accepts no parameters, but received unexpected fields: [${providedKeys.join(", ")}].`
      };
    }

    return { valid: true };
  }

  // 3. Case: Tool declares parameters
  if (callArgs === null || callArgs === undefined) {
    if (requiredKeys.length > 0) {
      return {
        valid: false,
        error: `Missing required parameters for tool '${toolDef.name}': Expected an object containing [${requiredKeys.join(", ")}].`
      };
    }
    return { valid: true };
  }

  // Check for malformed arguments (non-object or array)
  if (typeof callArgs !== "object" || Array.isArray(callArgs)) {
    return {
      valid: false,
      error: `Malformed arguments for tool '${toolDef.name}': Expected an object, received ${Array.isArray(callArgs) ? "array" : typeof callArgs}.`
    };
  }

  // Check required parameters
  for (const reqKey of requiredKeys) {
    if (!(reqKey in callArgs) || callArgs[reqKey] === undefined || callArgs[reqKey] === null) {
      return {
        valid: false,
        error: `Missing required parameter '${reqKey}' for tool '${toolDef.name}'.`
      };
    }
  }

  // Check each provided argument against property definitions
  for (const [key, val] of Object.entries(callArgs)) {
    const propSchema = declaredProps[key];
    if (!propSchema) {
      return {
        valid: false,
        error: `Unexpected argument '${key}' for tool '${toolDef.name}'. Declared parameters are: [${Object.keys(declaredProps).join(", ")}].`
      };
    }

    // Type validation
    if (val !== undefined && val !== null) {
      const expectedType = (propSchema.type || "").toLowerCase();
      
      switch (expectedType) {
        case "string":
          if (typeof val !== "string") {
            return {
              valid: false,
              error: `Invalid type for parameter '${key}' in tool '${toolDef.name}': Expected string, received ${typeof val}.`
            };
          }
          break;
        case "number":
          if (typeof val !== "number" || isNaN(val)) {
            return {
              valid: false,
              error: `Invalid type for parameter '${key}' in tool '${toolDef.name}': Expected number, received ${typeof val}.`
            };
          }
          break;
        case "integer":
          if (typeof val !== "number" || !Number.isInteger(val)) {
            return {
              valid: false,
              error: `Invalid type for parameter '${key}' in tool '${toolDef.name}': Expected integer, received ${typeof val}.`
            };
          }
          break;
        case "boolean":
          if (typeof val !== "boolean") {
            return {
              valid: false,
              error: `Invalid type for parameter '${key}' in tool '${toolDef.name}': Expected boolean, received ${typeof val}.`
            };
          }
          break;
        case "array":
          if (!Array.isArray(val)) {
            return {
              valid: false,
              error: `Invalid type for parameter '${key}' in tool '${toolDef.name}': Expected array, received ${typeof val}.`
            };
          }
          break;
        case "object":
          if (typeof val !== "object" || Array.isArray(val)) {
            return {
              valid: false,
              error: `Invalid type for parameter '${key}' in tool '${toolDef.name}': Expected object, received ${typeof val}.`
            };
          }
          break;
      }

      // Enum validation
      if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
        if (!propSchema.enum.includes(val)) {
          return {
            valid: false,
            error: `Invalid value for parameter '${key}' in tool '${toolDef.name}': Expected one of [${propSchema.enum.join(", ")}], received '${String(val)}'.`
          };
        }
      }
    }
  }

  return { valid: true };
}
