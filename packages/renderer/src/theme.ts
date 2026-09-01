/**
 * Visual design.
 *
 * Stage 1 is deliberately conservative: a user should recognise a table
 * instantly. Colours are linear RGBA in `[0, 1]` so they can go straight into
 * GPU buffers without a per-frame conversion.
 */

export type Rgba = readonly [number, number, number, number];

export interface TableTheme {
  readonly background: Rgba;
  readonly headerBackground: Rgba;
  readonly titleBackground: Rgba;
  /**
   * The title bar of a derived table — one produced by a statement rather than
   * read from a stored relation. A tint of the accent, so the difference reads
   * as "computed" at a glance without turning into a second visual language.
   */
  readonly derivedTitleBackground: Rgba;
  readonly derivedTitleText: Rgba;
  readonly gutterBackground: Rgba;
  readonly rowBackground: Rgba;
  readonly rowAlternateBackground: Rgba;
  readonly rowHoverBackground: Rgba;
  /**
   * A column picked out by clicking its header. Translucent over the body, so
   * the striping and the values still read through it, and solid on the header,
   * which is the thing that was clicked.
   */
  readonly columnSelectedBackground: Rgba;
  readonly columnSelectedHeaderBackground: Rgba;
  readonly columnSelectedBorder: Rgba;
  /**
   * The header under the pointer, which is a hint rather than a state: a column
   * header is clickable and looks like a label, so something has to say so
   * before it is clicked.
   *
   * The same hue as the selection it is hinting at, at a fraction of its
   * strength — a third. Being the same colour is what makes it read as "this is
   * what clicking does" rather than as a second, unrelated thing; being much
   * weaker is what keeps a pointer moving across a table from looking like a
   * selection following it around.
   */
  readonly columnHoverHeaderBackground: Rgba;
  readonly placeholderFill: Rgba;
  readonly gridLine: Rgba;
  readonly border: Rgba;
  readonly selectedBorder: Rgba;
  readonly titleText: Rgba;
  readonly headerText: Rgba;
  readonly typeText: Rgba;
  readonly cellText: Rgba;
  readonly gutterText: Rgba;
  readonly nullText: Rgba;
  /**
   * A property that was there and whose value was `null`.
   *
   * Its own colour because it is its own *fact*, and the one the whole document
   * view exists to make visible. `nullText` above draws a cell with nothing in
   * it; this draws a cell whose contents are nothing, which is a different
   * statement about the data — and drawing both in one grey is how the
   * distinction was lost. A hue rather than a shade, since a reader should not
   * have to compare two greys to know which they are looking at.
   */
  readonly jsonNullText: Rgba;
  /** A string that was there and was empty, which the database stored as NULL. */
  readonly jsonEmptyText: Rgba;
  /**
   * The type a variant's value arrived as, written small beside it.
   *
   * Dimmer than the value, because it is a note about the value and not part of
   * it: the eye should read the number first and find out it was a string second.
   */
  readonly jsonBranchTag: Rgba;
  /**
   * The mark on a column somebody has vouched for.
   *
   * Its own colour and not the accent the interface uses for things to click:
   * this is a statement about the data, and a reader must not learn to read it as
   * a control. Quiet enough to be scanned past on a table where every column
   * carries one, which is what a fully governed model looks like.
   */
  readonly semanticCertified: Rgba;
  readonly scrollbar: Rgba;
  readonly scrollbarTrack: Rgba;
  readonly resizeHandle: Rgba;
  readonly canvasBackground: Rgba;
  readonly haloBackground: Rgba;
  /** Hover and press for a destructive action, e.g. close. */
  readonly haloDangerBackground: Rgba;
  readonly haloDangerPressedBackground: Rgba;
  /** Hover and press for an ordinary action. */
  readonly haloAccentBackground: Rgba;
  readonly haloAccentPressedBackground: Rgba;
  readonly haloBorder: Rgba;
  readonly haloIcon: Rgba;
  readonly haloHoverIcon: Rgba;
  /** An action the table cannot perform: shown, but visibly inert. */
  readonly haloDisabledBackground: Rgba;
  readonly haloDisabledIcon: Rgba;
  readonly haloDisabledBorder: Rgba;
  /** The SQL editor a query box shows while its statement is being written. */
  readonly editorBackground: Rgba;
  readonly editorFieldBackground: Rgba;
  readonly editorText: Rgba;
  /**
   * A name in a statement that is not a real relation: the table the box was
   * opened on. Coloured because it is the one word in there that the database
   * has never heard of.
   */
  readonly editorReferenceText: Rgba;
  readonly connectorLine: Rgba;
  readonly connectorHighlight: Rgba;
  readonly connectorLabelText: Rgba;
  readonly connectorLabelBackground: Rgba;
  readonly connectorMarkerBackground: Rgba;
  readonly connectorMarkerHoverBackground: Rgba;
  readonly connectorMarkerBorder: Rgba;
  readonly connectorMarkerIcon: Rgba;
  readonly connectorMarkerHoverIcon: Rgba;
  /** Cells that can be followed to the rows their foreign key points at. */
  readonly linkText: Rgba;
  /**
   * The panel that opens under a picked-out column.
   *
   * Its own surface rather than the table's, because it is a statement *about*
   * the data rather than more of it, and the eye should not have to work out
   * which of the two it is reading.
   */
  readonly summaryPanelBackground: Rgba;
  readonly summaryPanelBorder: Rgba;
  /** Bars: the filled part, and the track showing what a full bar would be. */
  readonly summaryBar: Rgba;
  readonly summaryBarTrack: Rgba;
  /** What is missing, and anything else the reader must not skim past. */
  readonly summaryNullBar: Rgba;

  readonly titleHeight: number;
  readonly typeRowHeight: number;
  readonly cellPaddingX: number;
  readonly gridLineWidth: number;
  readonly borderWidth: number;
  readonly scrollbarWidth: number;
  readonly scrollbarMinLength: number;
  readonly resizeMargin: number;
  /** Diameter of a halo button, in screen pixels. */
  readonly haloButtonSize: number;
  /**
   * How far a halo button's corners are rounded, in screen pixels.
   *
   * The same three pixels the explorer's rows use, on a button the same height as
   * one — the canvas and the panel beside it are one interface, and a control
   * that is square where every control in the sidebar is rounded reads as an
   * older part of the application.
   */
  readonly haloCornerRadius: number;
  readonly haloGap: number;
  /** Distance from the table's top edge to the halo, in screen pixels. */
  readonly haloOffset: number;
  readonly haloIconFontSize: number;
  readonly editorFontSize: number;
  readonly editorPadding: number;
  /** Shown under the statement; names the gesture that runs it. */
  readonly editorHint: string;
  /** Connector metrics, in screen pixels. */
  readonly connectorWidth: number;
  readonly connectorGap: number;
  readonly connectorArrowLength: number;
  readonly connectorArrowWidth: number;
  readonly connectorLabelFontSize: number;
  readonly connectorLabelPaddingX: number;
  /** Side of the square marker sitting on a connector, in screen pixels. */
  readonly connectorMarkerSize: number;
  readonly connectorMarkerIconSize: number;
  readonly fontSize: number;
  readonly headerFontSize: number;
  readonly typeFontSize: number;
  readonly titleFontSize: number;
}

const rgb = (hex: number, alpha = 1): Rgba => [
  ((hex >> 16) & 0xff) / 255,
  ((hex >> 8) & 0xff) / 255,
  (hex & 0xff) / 255,
  alpha,
];

export const DEFAULT_TABLE_THEME: TableTheme = Object.freeze({
  background: rgb(0xff_ff_ff),
  headerBackground: rgb(0xf4_f5_f7),
  titleBackground: rgb(0xe9_ec_ef),
  derivedTitleBackground: rgb(0xdd_e7_fa),
  derivedTitleText: rgb(0x14_3c_78),
  gutterBackground: rgb(0xf8_f9_fa),
  rowBackground: rgb(0xff_ff_ff),
  rowAlternateBackground: rgb(0xfa_fb_fc),
  rowHoverBackground: rgb(0xe8_f1_fb),
  columnSelectedBackground: rgb(0x2f_6f_ed, 0.1),
  columnSelectedHeaderBackground: rgb(0x2f_6f_ed, 0.22),
  columnHoverHeaderBackground: rgb(0x2f_6f_ed, 0.08),
  columnSelectedBorder: rgb(0x2f_6f_ed, 0.55),
  placeholderFill: rgb(0xdf_e3_e8, 0.75),
  gridLine: rgb(0xe3_e6_ea),
  border: rgb(0xb9_c0_c8),
  selectedBorder: rgb(0x2f_6f_ed),
  titleText: rgb(0x1c_21_27),
  headerText: rgb(0x2b_31_38),
  typeText: rgb(0x76_7f_89),
  cellText: rgb(0x21_26_2c),
  gutterText: rgb(0x8b_94_9e),
  nullText: rgb(0xa9_b1_ba),
  jsonNullText: rgb(0x8a_44_c8),
  jsonEmptyText: rgb(0x6b_7a_8f),
  jsonBranchTag: rgb(0x8b_94_9e),
  semanticCertified: rgb(0x2f_8f_6a),
  scrollbar: rgb(0x9a_a3_ad, 0.75),
  scrollbarTrack: rgb(0x00_00_00, 0.05),
  resizeHandle: rgb(0x2f_6f_ed, 0.85),
  canvasBackground: rgb(0xf1_f3_f5),
  haloBackground: rgb(0xff_ff_ff, 0.96),
  haloDangerBackground: rgb(0xd6_3b_2f),
  haloDangerPressedBackground: rgb(0xa8_2c_22),
  haloAccentBackground: rgb(0x1a_73_e8),
  haloAccentPressedBackground: rgb(0x14_5a_b8),
  haloBorder: rgb(0xb9_c0_c8),
  haloIcon: rgb(0x3c_44_4d),
  haloHoverIcon: rgb(0xff_ff_ff),
  haloDisabledBackground: rgb(0xf2_f4_f6, 0.96),
  haloDisabledIcon: rgb(0xa8_b0_b8),
  haloDisabledBorder: rgb(0xdd_e2_e6),
  editorBackground: rgb(0xf7_f8_fa),
  editorFieldBackground: rgb(0xff_ff_ff),
  editorText: rgb(0x1f_25_2b),
  editorReferenceText: rgb(0x8a_44_c8),
  connectorLine: rgb(0x6b_7a_8f),
  connectorHighlight: rgb(0x2f_6f_ed),
  connectorLabelText: rgb(0x3c_44_4d),
  connectorLabelBackground: rgb(0xff_ff_ff, 0.97),
  connectorMarkerBackground: rgb(0xff_ff_ff, 0.97),
  connectorMarkerHoverBackground: rgb(0x2f_6f_ed),
  connectorMarkerBorder: rgb(0x9a_a3_ad),
  connectorMarkerIcon: rgb(0x5c_66_71),
  connectorMarkerHoverIcon: rgb(0xff_ff_ff),
  linkText: rgb(0x1c_5b_c4),
  summaryPanelBackground: rgb(0xff_ff_ff, 0.98),
  summaryPanelBorder: rgb(0x9a_a3_ad),
  summaryBar: rgb(0x2f_6f_ed, 0.85),
  summaryBarTrack: rgb(0xdf_e3_e8),
  summaryNullBar: rgb(0xd6_7b_2f),

  titleHeight: 26,
  typeRowHeight: 22,
  cellPaddingX: 8,
  gridLineWidth: 1,
  borderWidth: 1,
  scrollbarWidth: 8,
  scrollbarMinLength: 24,
  resizeMargin: 6,
  haloButtonSize: 22,
  haloCornerRadius: 3,
  haloGap: 6,
  haloOffset: 8,
  haloIconFontSize: 15,
  editorFontSize: 13,
  editorPadding: 10,
  editorHint: 'Press ⌘↵ (Ctrl+↵) to run',
  connectorWidth: 1.75,
  connectorGap: 4,
  connectorArrowLength: 11,
  connectorArrowWidth: 9,
  connectorLabelFontSize: 10,
  connectorLabelPaddingX: 6,
  connectorMarkerSize: 22,
  connectorMarkerIconSize: 15,
  fontSize: 12,
  headerFontSize: 12,
  typeFontSize: 10,
  titleFontSize: 13,
});
