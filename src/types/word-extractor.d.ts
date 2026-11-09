declare module "word-extractor" {
  interface WordDocument {
    getBody(): string;
  }

  class WordExtractor {
    extract(input: Buffer): Promise<WordDocument>;
  }

  export = WordExtractor;
}
