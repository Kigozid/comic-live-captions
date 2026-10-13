declare module 'clipper-lib' {
  interface IntPoint {
    X: number;
    Y: number;
  }

  type Path = IntPoint[];
  type Paths = Path[];

  interface ClipperInstance {
    AddPath(path: Path, polyType: number, closed: boolean): boolean;
    AddPaths(paths: Paths, polyType: number, closed: boolean): boolean;
    Execute(
      clipType: number,
      solution: Paths,
      subjectFillType: number,
      clipFillType: number,
    ): boolean;
  }

  const ClipperLib: {
    readonly Clipper: { new (): ClipperInstance };
    readonly ClipType: {
      readonly ctIntersection: number;
      readonly ctUnion: number;
    };
    readonly PolyType: { readonly ptSubject: number; readonly ptClip: number };
    readonly PolyFillType: { readonly pftNonZero: number };
  };

  export = ClipperLib;
}
