import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { ApolloServer } from '@apollo/server';
import { buildSubgraphSchema } from '@apollo/subgraph';
import { parse } from 'graphql';

export const typeDefs = parse(
  readFileSync(join(__dirname, 'typeDefs.graphql'), 'utf8'),
);

export const resolvers = {
  Product: {
    __resolveReference(object: any) {
      return {
        ...object,
        ...inventory.find((product) => product.upc === object.upc),
      };
    },
    shippingEstimate(object: any) {
      if (object.price == null || object.weight == null) {
        throw new Error(
          `${inspect(object)} doesn't have required fields; "price" and "weight".`,
        );
      }
      // free for expensive items
      if (object.price > 1000) return 0;
      // estimate is based on weight
      return object.weight * 0.5;
    },
  },
};

export const schema = buildSubgraphSchema([
  {
    typeDefs,
    resolvers,
  },
]);

export const server = new ApolloServer({
  schema,
});

const inventory = [
  { upc: '1', inStock: true },
  { upc: '2', inStock: false },
  { upc: '3', inStock: true },
];
