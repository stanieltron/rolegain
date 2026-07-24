declare module "word-extractor" {
  class WordDocument {
    getBody(): string;
  }

  export default class WordExtractor {
    extract(source: Buffer | string): Promise<WordDocument>;
  }
}
