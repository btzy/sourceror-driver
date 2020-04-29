import * as Sourceror from "sourceror";
import { Context } from "js-slang";
import { ErrorType, ErrorSeverity } from "js-slang/dist/types";
import { parse as slang_parse } from "js-slang/dist/parser/parser";
import * as es from "estree";

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export async function compile(
  code: string,
  context: Context
): Promise<WebAssembly.Module> {
  let estree: es.Program | undefined = slang_parse(code, context);
  if (!estree) {
    return Promise.reject(
      new CompileError("js-slang cannot parse the program")
    );
  }
    let es_str: string = JSON.stringify(estree);
    let has_errors: boolean = false;
    let wasm_context: number = Sourceror.create_context((severity_code: number, message: string, line: number, column: number) => {
        if (severity_code >= 4) has_errors = true;
        context.errors.push({
            type: ErrorType.SYNTAX,
            severity: severity_code >= 4 ? ErrorSeverity.ERROR : ErrorSeverity.WARNING, // Sourceror supports other severity levels, but js-slang does not
            location: {
                source: null,
                start: {
                    line,
                    column,
                },
                end: {
                    line,
                    column: column + 1,
                },
            },
            explain: (): string => message,
            elaborate: (): string => "",
        });
    });
    return Sourceror.compile(wasm_context, es_str, "")
        .then((wasm_binary: Uint8Array) => {
            if (!has_errors) {
                return WebAssembly.compile(wasm_binary).catch((err: string) => {
                    context.errors.push({
                        type: ErrorType.SYNTAX,
                        severity: ErrorSeverity.ERROR,
                        location: {
                            source: null,
                            start: {
                                line: 0,
                                column: 0,
                            },
                            end: {
                                line: 0,
                                column: 0,
                            },
                        },
                        explain: (): string => err,
                        elaborate: (): string => "Your browser's WebAssembly engine is unable to compile the WebAssembly binary produced by Sourceror.  This is probably a bug in Sourceror; please report it.",
                    });
                    return Promise.reject(
                        new CompileError("WebAssembly compilation error")
                    );
                });
            }
            else {
                return Promise.reject(
                    new CompileError("Syntax error")
                );
            }
        })
        .then((x: WebAssembly.Module) => {
            Sourceror.destroy_context(wasm_context);
            return x;
        }, (e: any) => {
            Sourceror.destroy_context(wasm_context);
            return e;
        });
}

function read_js_result(linear_memory: WebAssembly.Memory): any {
  const mem = new DataView(linear_memory.buffer);
  const tag = mem.getUint32((1 << 20) - 12, true);
  const data_offset = (1 << 20) - 8;
  switch (tag) {
    case 0:
      return "(unassigned variable was returned)";
    case 1:
      return undefined;
    case 2:
      return mem.getFloat64(data_offset, true);
    case 3:
      return mem.getUint32(data_offset, true) !== 0;
    case 4: {
      const ptr = mem.getUint32(data_offset, true);
      const len = mem.getUint32(ptr, true);
      const decoder = new TextDecoder();
      const res = decoder.decode(
        new Uint8Array(linear_memory.buffer, ptr + 4, len)
      );
      return res;
    }
    case 5:
      return "(function was returned)";
    default:
      return "(struct or invalid type (" + tag + ") was returned)";
  }
}

function stringifySourcerorRuntimeErrorCode(code: number): [string, string] {
  switch (code) {
    case 0x0:
      return ["General runtime error", ""];
    case 0x1:
      return [
        "Out of memory",
        "Strings and objects are allocated on the heap.  You have exhausted the available heap space.  Try recompiling your program with increased heap space.",
      ];
    case 0x10:
      return ["General runtime type error", ""];
    case 0x12:
      return ["Unary operator called with incorrect parameter type", ""];
    case 0x13:
      return ["Binary operator called with incorrect parameter type", ""];
    case 0x16:
      return ["Function call operator applied on a non-function", ""];
    case 0x17:
      return ["If statement has a non-boolean condition", ""];
    default:
      return [
        "Unknown runtime error",
        "This is probably a bug in Sourceror; please report it.",
      ];
  }
}

// Just a unique identifier used for throwing exceptions while running the webassembly code
const propagationToken = {};

export async function run(
  wasm_module: WebAssembly.Module,
  context: Context
): Promise<any> {
  return WebAssembly.instantiate(wasm_module, {
    core: {
      error: (
        code: number,
        detail: number,
        file: number,
        line: number,
        column: number
      ) => {
        const [explain, elaborate] = stringifySourcerorRuntimeErrorCode(code);
        context.errors.push({
          type: ErrorType.RUNTIME,
          severity: ErrorSeverity.ERROR,
          location: {
            source: null,
            start: {
              line,
              column,
            },
            end: {
              line,
              column: column + 1,
            },
          },
          explain: (): string => explain,
          elaborate: (): string => elaborate,
        });
        throw propagationToken; // to stop the webassembly binary immediately
      },
    },
  }).then((instance) => {
    try {
      (instance.exports.main as Function)();
      return read_js_result(
        instance.exports.linear_memory as WebAssembly.Memory
      );
    } catch (e) {
      if (e === propagationToken) {
        return Promise.reject(new RuntimeError("runtime error"));
      } else {
        context.errors.push({
          type: ErrorType.RUNTIME,
          severity: ErrorSeverity.ERROR,
          location: {
            source: null,
            start: {
              line: 0,
              column: 0,
            },
            end: {
              line: 0,
              column: 0,
            },
          },
          explain: (): string => e.toString(),
          elaborate: (): string => e.toString(),
        });
        return Promise.reject(e);
      }
    }
  });
}
