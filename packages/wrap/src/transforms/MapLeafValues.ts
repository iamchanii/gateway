import {
  DelegationContext,
  SubschemaConfig,
  Transform,
} from '@graphql-tools/delegate';
import {
  astFromValueUntyped,
  ExecutionRequest,
  ExecutionResult,
  ResultVisitorMap,
  transformInputValue,
  visitResult,
} from '@graphql-tools/utils';
import {
  ArgumentNode,
  astFromValue,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLSchema,
  isLeafType,
  Kind,
  OperationDefinitionNode,
  TypeInfo,
  valueFromAST,
  valueFromASTUntyped,
  visit,
  visitWithTypeInfo,
} from 'graphql';
import { getTypeInfo } from '../../../delegate/src/getTypeInfo.js';
import { LeafValueTransformer } from '../types.js';

export interface MapLeafValuesTransformationContext {
  transformedRequest: ExecutionRequest;
}

export default class MapLeafValues<TContext = Record<string, any>>
  implements Transform<MapLeafValuesTransformationContext, TContext>
{
  private readonly inputValueTransformer: LeafValueTransformer;
  private readonly outputValueTransformer: LeafValueTransformer;
  private readonly resultVisitorMap: ResultVisitorMap;
  private typeInfo?: TypeInfo;

  constructor(
    inputValueTransformer: LeafValueTransformer,
    outputValueTransformer: LeafValueTransformer,
  ) {
    this.inputValueTransformer = inputValueTransformer;
    this.outputValueTransformer = outputValueTransformer;
    this.resultVisitorMap = Object.create(null);
  }

  private originalWrappingSchema?: GraphQLSchema;

  public transformSchema(
    originalWrappingSchema: GraphQLSchema,
    _subschemaConfig: SubschemaConfig<any, any, any, TContext>,
  ): GraphQLSchema {
    this.originalWrappingSchema = originalWrappingSchema;
    const typeMap = originalWrappingSchema.getTypeMap();
    for (const typeName in typeMap) {
      const type = typeMap[typeName];
      if (!typeName.startsWith('__')) {
        if (isLeafType(type)) {
          this.resultVisitorMap[typeName] = (value: any) =>
            this.outputValueTransformer(typeName, value);
        }
      }
    }
    this.typeInfo = getTypeInfo(originalWrappingSchema);
    return originalWrappingSchema;
  }

  public transformRequest(
    originalRequest: ExecutionRequest,
    delegationContext: DelegationContext<TContext>,
    transformationContext: MapLeafValuesTransformationContext,
  ): ExecutionRequest {
    const document = originalRequest.document;
    const variableValues = originalRequest.variables ?? {};

    const operations: Array<OperationDefinitionNode> =
      document.definitions.filter(
        (def) => def.kind === Kind.OPERATION_DEFINITION,
      ) as Array<OperationDefinitionNode>;
    const fragments: Array<FragmentDefinitionNode> =
      document.definitions.filter(
        (def) => def.kind === Kind.FRAGMENT_DEFINITION,
      ) as Array<FragmentDefinitionNode>;

    const newOperations = this.transformOperations(
      operations,
      variableValues,
      delegationContext.args,
    );

    const transformedRequest = {
      ...originalRequest,
      document: {
        ...document,
        definitions: [...newOperations, ...fragments],
      },
      variables: variableValues,
    };

    transformationContext.transformedRequest = transformedRequest;

    return transformedRequest;
  }

  public transformResult(
    originalResult: ExecutionResult,
    _delegationContext: DelegationContext<TContext>,
    transformationContext: MapLeafValuesTransformationContext,
  ): ExecutionResult {
    if (!this.originalWrappingSchema) {
      throw new Error(
        `The MapLeafValues transform's  "transformRequest" and "transformResult" methods cannot be used without first calling "transformSchema".`,
      );
    }
    return visitResult(
      originalResult,
      transformationContext.transformedRequest,
      this.originalWrappingSchema,
      this.resultVisitorMap,
    );
  }

  private transformOperations(
    operations: Array<OperationDefinitionNode>,
    variableValues: Record<string, any>,
    args?: Record<string, any>,
  ): Array<OperationDefinitionNode> {
    if (this.typeInfo == null) {
      throw new Error(
        `The MapLeafValues transform's "transformRequest" and "transformResult" methods cannot be used without first calling "transformSchema".`,
      );
    }
    return operations.map((operation: OperationDefinitionNode) => {
      return visit(
        operation,
        visitWithTypeInfo(this.typeInfo!, {
          [Kind.FIELD]: (node) =>
            this.transformFieldNode(node, variableValues, args),
        }),
      );
    });
  }

  private transformFieldNode(
    field: FieldNode,
    variableValues: Record<string, any>,
    args?: Record<string, any>,
  ): FieldNode | undefined {
    if (this.typeInfo == null) {
      throw new Error(
        `The MapLeafValues transform's "transformRequest" and "transformResult" methods cannot be used without first calling "transformSchema".`,
      );
    }
    const targetField = this.typeInfo.getFieldDef();

    if (!targetField) {
      return;
    }

    if (!targetField.name.startsWith('__')) {
      const argumentNodes = field.arguments;
      if (argumentNodes != null) {
        const argumentNodeMap: Record<string, ArgumentNode> =
          argumentNodes.reduce(
            (prev, argument) => ({
              ...prev,
              [argument.name.value]: argument,
            }),
            Object.create(null),
          );

        for (const argument of targetField.args) {
          const argName = argument.name;
          const argType = argument.type;
          if (args?.[argName] != null) {
            args[argName] = transformInputValue(
              argType,
              args[argName],
              (t, v) => {
                const newValue = this.inputValueTransformer(t.name, v);
                return newValue === undefined ? v : newValue;
              },
            );
          }

          const argumentNode = argumentNodeMap[argName];

          let value: any;
          const argValue = argumentNode?.value;
          if (argValue != null) {
            value = valueFromAST(argValue, argType, variableValues);
            if (value == null) {
              value = valueFromASTUntyped(argValue, variableValues);
            }
          }

          const transformedValue = transformInputValue(
            argType,
            value,
            (t, v) => {
              const newValue = this.inputValueTransformer(t.name, v);
              return newValue === undefined ? v : newValue;
            },
          );

          if (argValue?.kind === Kind.VARIABLE) {
            variableValues[argValue.name.value] = transformedValue;
          } else {
            let newValueNode: any;
            try {
              newValueNode = astFromValue(transformedValue, argType);
            } catch (e) {
              newValueNode = astFromValueUntyped(transformedValue);
            }
            if (newValueNode != null) {
              argumentNodeMap[argName] = {
                ...argumentNode!,
                value: newValueNode,
              };
            }
          }
        }

        return {
          ...field,
          arguments: Object.values(argumentNodeMap),
        };
      }
    }
    return undefined;
  }
}
