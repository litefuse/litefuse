// @ts-nocheck
import { genWhereSQL, parse } from "./ast";
import { SQLSerializer } from "./serializers";

export { parse, genWhereSQL, genEnglishExplanation } from "./ast";
export { SQLSerializer, CustomSchemaSQLSerializerV2 } from "./serializers";

export class SearchQueryBuilder {
  private readonly searchQ: string;
  private readonly conditions: string[];
  private serializer: SQLSerializer;

  constructor(searchQ: string, serializer: SQLSerializer) {
    this.conditions = [];
    this.searchQ = searchQ;
    this.serializer = serializer;
  }

  setSerializer(serializer: SQLSerializer) {
    this.serializer = serializer;
    return this;
  }

  getSerializer() {
    return this.serializer;
  }

  private async genSearchQuery() {
    if (!this.searchQ) {
      return "";
    }

    const parsedQ = parse(this.searchQ);

    return await genWhereSQL(parsedQ, this.serializer);
  }

  and(condition: string) {
    if (condition && condition.trim()) {
      this.conditions.push(`(${condition})`);
    }
    return this;
  }

  async build() {
    const searchQuery = await this.genSearchQuery();
    if (this.searchQ) {
      this.and(searchQuery);
    }
    return this.conditions.join(" AND ");
  }
}
