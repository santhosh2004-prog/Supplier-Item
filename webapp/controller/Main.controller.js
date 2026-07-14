sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/m/VBox",
    "sap/m/HBox",
    "sap/m/Text",
    "sap/m/Label",
    "sap/m/Table",
    "sap/m/Column",
    "sap/m/ColumnListItem",
    "sap/m/Button",
    "sap/m/BusyIndicator",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageToast",
    "sap/m/Link",
    "sap/ui/core/Fragment",
  ],
  function (
    Controller,
    VBox,
    HBox,
    Text,
    Label,
    Table,
    Column,
    ColumnListItem,
    Button,
    BusyIndicator,
    Filter,
    FilterOperator,
    JSONModel,
    MessageToast,
    Link,
    Fragment,
  ) {
    "use strict";

    // ─── HELPERS ──────────────────────────────────────────────────────────────────

    var fnFmtDate = function (oVal) {
      if (!oVal) return "";
      if (oVal instanceof Date) return oVal.toLocaleDateString("en-IN");
      var n = parseInt(String(oVal).replace(/\/Date\((\d+)\)\//, "$1"), 10);
      return isNaN(n) ? String(oVal) : new Date(n).toLocaleDateString("en-IN");
    };

    var fnFmtAmt = function (val) {
      if (val === null || val === undefined) return "0.00";
      return parseFloat(val).toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 3,
      });
    };

    var fnMakeBusyRow = function (sId) {
      var oBusy = new BusyIndicator({
        id: sId,
        size: "1rem",
        visible: true,
      }).addStyleClass("sectionBusyIndicator");

      return new HBox({
        id: sId + "-row",
        justifyContent: "Center",
        alignItems: "Center",
        items: [oBusy],
      }).addStyleClass("busyRow");
    };

    // ─── CONTROLLER ───────────────────────────────────────────────────────────────

    return Controller.extend("supplieropenitems.controller.Main", {
      onInit: function () {
        // Logo model
        var oModel = new JSONModel({
          logo: sap.ui.require.toUrl(
            "supplieropenitems/images/evrest_logo.png",
          ),
        });
        this.getView().setModel(oModel, "img");

        // Empty JSON models for the two F4 dialogs
        this.getView().setModel(
          new JSONModel({ results: [] }),
          "compCodeModel",
        );
        this.getView().setModel(
          new JSONModel({ results: [] }),
          "supplierModel",
        );

        // Dialog references (lazy-loaded)
        this._oCompCodeDialog = null;
        this._oSupplierDialog = null;
      },

      // ══════════════════════════════════════════════════════════════════════════════
      //  VALUE HELP  –  COMPANY CODE   (CompCodeF4Set)
      // ══════════════════════════════════════════════════════════════════════════════

      /** Called when the value-help icon on the Company Code input is pressed */
      onCompCodeF4: function () {
        var that = this;

        // ── Lazy-load the fragment once ────────────────────────────────────────
        if (!this._oCompCodeDialog) {
          Fragment.load({
            id: this.getView().getId(),
            name: "supplieropenitems.view.fragment.CompCodeF4",
            controller: this,
          }).then(function (oDialog) {
            that._oCompCodeDialog = oDialog;
            that.getView().addDependent(oDialog);
            that._fetchCompCodes(oDialog);
          });
        } else {
          // Dialog already exists – just reload data and open
          this._fetchCompCodes(this._oCompCodeDialog);
        }
      },

      /** Read CompCodeF4Set and open the SelectDialog */
      _fetchCompCodes: function (oDialog) {
        var oOData = this.getOwnerComponent().getModel();
        var that = this;

        oDialog.setBusy(true);
        oDialog.open();

        oOData.read("/CompCodeF4Set", {
          success: function (oData) {
            oDialog.setBusy(false);

            // Store results in the named JSON model
            that.getView().getModel("compCodeModel").setData(oData);

            // Bind the dialog items aggregation with a fresh template
            oDialog.bindAggregation("items", {
              path: "compCodeModel>/results",
              template: new sap.m.StandardListItem({
                title: "{compCodeModel>Bukrs}",
                description: "{compCodeModel>Butxt}",
                type: "Active",
              }),
            });
          },
          error: function () {
            oDialog.setBusy(false);
            MessageToast.show("Error loading company codes.");
          },
        });
      },

      /** Live search inside Company Code dialog */
      onCompCodeSearch: function (oEvent) {
        var sValue = oEvent.getParameter("value");
        var oFilter = new Filter({
          filters: [
            new Filter("Bukrs", FilterOperator.Contains, sValue),
            new Filter("Butxt", FilterOperator.Contains, sValue),
          ],
          and: false,
        });
        oEvent.getSource().getBinding("items").filter([oFilter]);
      },

      /** User confirms a Company Code selection */
      onCompCodeConfirm: function (oEvent) {
        var oSelected = oEvent.getParameter("selectedItem");
        if (oSelected) {
          // Bind the selected Bukrs back to the input
          this.byId("inputBukrs").setValue(
            oSelected.getTitle(), // Bukrs
          );
        }
      },

      onCompCodeDialogClose: function () {
        if (this._oCompCodeDialog) {
          this._oCompCodeDialog.close();
        }
      },

      // ══════════════════════════════════════════════════════════════════════════════
      //  VALUE HELP  –  SUPPLIER   (SupplierF4Set)
      // ══════════════════════════════════════════════════════════════════════════════

      /** Called when the value-help icon on the Supplier input is pressed */
      onSupplierF4: function () {
        var that = this;

        if (!this._oSupplierDialog) {
          Fragment.load({
            id: this.getView().getId(),
            name: "supplieropenitems.view.fragment.SupplierF4",
            controller: this,
          }).then(function (oDialog) {
            that._oSupplierDialog = oDialog;
            that.getView().addDependent(oDialog);
            that._fetchSuppliers(oDialog);
          });
        } else {
          this._fetchSuppliers(this._oSupplierDialog);
        }
      },

      /** Read SupplierF4Set – optionally filter by current Bukrs if filled ──────
       *  If Company Code is already filled, pass it as a filter so the supplier
       *  list is narrowed to that company; otherwise fetch all.
       */
      _fetchSuppliers: function (oDialog) {
        var oOData = this.getOwnerComponent().getModel();
        var that = this;
        var sBukrs = this.byId("inputBukrs").getValue().trim();

        oDialog.setBusy(true);
        oDialog.open();

        var aFilters = [];
        if (sBukrs) {
          aFilters.push(new Filter("Bukrs", FilterOperator.EQ, sBukrs));
        }

        oOData.read("/SupplierF4Set", {
          success: function (oData) {
            oDialog.setBusy(false);
            that.getView().getModel("supplierModel").setData(oData);

            // Bind the dialog items aggregation with a fresh template
            oDialog.bindAggregation("items", {
              path: "supplierModel>/results",
              template: new sap.m.StandardListItem({
                title: "{supplierModel>Lifnr}",
                description: "{supplierModel>Name1}",
                type: "Active",
              }),
            });
          },
          error: function () {
            oDialog.setBusy(false);
            MessageToast.show("Error loading suppliers.");
          },
        });
      },

      /** Live search inside Supplier dialog */
      onSupplierSearch: function (oEvent) {
        var sValue = oEvent.getParameter("value");
        var oFilter = new Filter({
          filters: [
            new Filter("Lifnr", FilterOperator.Contains, sValue),
            new Filter("Name1", FilterOperator.Contains, sValue),
          ],
          and: false,
        });
        oEvent.getSource().getBinding("items").filter([oFilter]);
      },

      /** User confirms a Supplier selection */
      onSupplierConfirm: function (oEvent) {
        var oSelected = oEvent.getParameter("selectedItem");
        if (oSelected) {
          this.byId("inputLifnr").setValue(
            oSelected.getTitle(), // Lifnr
          );
        }
      },

      onSupplierDialogClose: function () {
        if (this._oSupplierDialog) {
          this._oSupplierDialog.close();
        }
      },

      // ══════════════════════════════════════════════════════════════════════════════
      //  FILTER BAR  –  Search / Reset
      // ══════════════════════════════════════════════════════════════════════════════

      onFilterChange: function () {
        // intentionally left for future live-filter use
      },
      // ══════════════════════════════════════════════════════════════════════════════
      //  RESET  –  wipes every model/state tied to the recon container
      // ══════════════════════════════════════════════════════════════════════════════

      _resetReconState: function () {
        var oContainer = this.byId("reconContainer");

        // Kill any in-flight busy state and stale bindings
        oContainer.setBusy(false);
        oContainer.setModel(null, "recon");
        oContainer.removeAllItems();

        // Drop the old model reference entirely so nothing can write into
        // a model that's no longer bound to anything
        this._oReconModel = null;

        // Clear cached filter state from the previous search
        this._sBukrs = null;
        this._sKeyDate = null;
        this._sLifnr = null;
      },

      onSearch: function () {
        var sBukrs = this.byId("inputBukrs").getValue().trim();
        var sLifnr = this.byId("inputLifnr").getValue().trim();
        var sKeyDate = this.byId("inputKeyDate").getValue().trim();

        if (!sBukrs) {
          MessageToast.show("Please enter a Company Code.");
          return;
        }
        if (!sKeyDate) {
          MessageToast.show("Please enter a Key Date.");
          return;
        }
        this._resetReconState();

        if (sLifnr && sBukrs && sKeyDate) {
          this.loadReconFilteredByVendor(sBukrs, sLifnr, sKeyDate);
          return;
        }

        this.loadRecon(sBukrs, sLifnr, sKeyDate);
      }, // ── tiny promisify helper so we can Promise.all the VENDERSet calls ──────
      _odataRead: function (oModel, sPath, mParams) {
        return new Promise(function (resolve, reject) {
          oModel.read(
            sPath,
            Object.assign({}, mParams, {
              success: function (oData) {
                resolve(oData);
              },
              error: function (oError) {
                reject(oError);
              },
            }),
          );
        });
      },
      // ══════════════════════════════════════════════════════════════════════════════
      //  RECON FILTERED BY VENDOR  (Bukrs + Lifnr + KeyDate all supplied)
      // ══════════════════════════════════════════════════════════════════════════════

      /**
       * ReconSet has no Lifnr field, so we can't filter it directly by vendor.
       * Instead: read all Recon rows for Bukrs/Budat, then for each row's Akont
       * check VENDERSet for a matching Lifnr. Only rows with a match survive,
       * and since we already have that vendor's data in hand, we write it
       * straight into the model instead of lazy-loading it on toggle.
       */
      loadReconFilteredByVendor: function (sBukrs, sLifnr, sKeyDate) {
        var oModel = this.getOwnerComponent().getModel();
        if (!oModel) {
          console.error("No OData model found.");
          return;
        }

        this._sBukrs = sBukrs;
        this._sKeyDate = sKeyDate;
        this._sLifnr = sLifnr;

        var oContainer = this.byId("reconContainer");
        oContainer.setBusy(true);
        // On refresh, always start clean rather than layering on stale bindings/models
        oContainer.setModel(null, "recon");
        this._oReconModel = null;

        var that = this;

        this._odataRead(oModel, "/ReconSet", {
          filters: [
            new Filter("Bukrs", FilterOperator.EQ, sBukrs),
            new Filter("Budat", FilterOperator.EQ, new Date(sKeyDate)),
          ],
        })
          .then(function (oReconData) {
            var aReconResults = oReconData.results || [];

            if (aReconResults.length === 0) {
              oContainer.setBusy(false);
              MessageToast.show("No reconciliation records found.");
              return;
            }

            // Fire a VENDERSet read per recon row, in parallel, each resolving to
            // either the matched vendor or null so we can zip results back up.
            var aVendorChecks = aReconResults.map(function (oRecon) {
              var sAkont = String(oRecon.Akont).padStart(10, "0");

              return that
                ._odataRead(oModel, "/VENDERSet", {
                  filters: [
                    new Filter("BUKRS", FilterOperator.EQ, sBukrs),
                    new Filter("BUDAT", FilterOperator.EQ, new Date(sKeyDate)),
                    new Filter("AKONT", FilterOperator.EQ, sAkont),
                  ],
                })
                .then(function (oVendorData) {
                  var aVendors = oVendorData.results || [];
                  var oMatch = aVendors.find(function (oVendor) {
                    return oVendor.LIFNR === sLifnr;
                  });
                  return { oRecon: oRecon, oMatch: oMatch || null };
                })
                .catch(function (oError) {
                  console.error(
                    "VENDERSet read failed for Akont",
                    sAkont,
                    oError,
                  );
                  return { oRecon: oRecon, oMatch: null };
                });
            });

            return Promise.all(aVendorChecks).then(function (aResults) {
              oContainer.setBusy(false);

              var aMatched = aResults.filter(function (o) {
                return o.oMatch !== null;
              });

              if (aMatched.length === 0) {
                MessageToast.show(
                  "No matching supplier found for the given Company Code / Key Date.",
                );
                return;
              }

              that._buildReconModelWithVendorMatch(aMatched);
              that.renderReconTable();
            });
          })
          .catch(function (oError) {
            oContainer.setBusy(false);
            console.error("ReconSet read failed:", oError);
            MessageToast.show("Error loading recon data.");
          });
      },

      // ── build the recon model, pre-populating the matched vendor per row ────
      _buildReconModelWithVendorMatch: function (aMatched) {
        var aItems = aMatched.map(function (o) {
          var oRecon = o.oRecon;
          var oMatch = o.oMatch;

          var oVendorRow = {
            LIFNR: oMatch.LIFNR,
            NAME1: oMatch.NAME1,
            AKONT: oMatch.AKONT,
            INV_AMT: oMatch.INV_AMT,
            ADV_AMT: oMatch.ADV_AMT,
            NET_AMT: oMatch.NET_AMT,

            // Auto-expand this row since it's the one the user searched for
            expanded: false,
            itemsLoaded: false,
            itemsBusy: false,
            openItems: [],
          };

          return {
            Txt50: oRecon.Txt50,
            InvAmt: oRecon.InvAmt,
            AdvAmt: oRecon.AdvAmt,
            Akont: oRecon.Akont,
            Bukrs: oRecon.Bukrs,
            Lifnr: oRecon.Lifnr,

            // Recon row + vendor section already expanded and populated
            expanded: true,
            vendorsLoaded: true,
            vendorsBusy: false,
            vendors: [oVendorRow],
            vendorTotals: {
              InvAmt: parseFloat(oMatch.INV_AMT) || 0,
              AdvAmt: parseFloat(oMatch.ADV_AMT) || 0,
              NetAmt: parseFloat(oMatch.NET_AMT) || 0,
            },
          };
        });

        var nTotalInv = aItems.reduce(function (acc, o) {
          return acc + (parseFloat(o.InvAmt) || 0);
        }, 0);
        var nTotalAdv = aItems.reduce(function (acc, o) {
          return acc + (parseFloat(o.AdvAmt) || 0);
        }, 0);

        var oReconModel = new JSONModel({
          items: aItems,
          totals: { InvAmt: nTotalInv, AdvAmt: nTotalAdv },
          // Flag used purely to drive UI: when the search was narrowed to a
          // single vendor, the outer grand-Total row is redundant with the
          // vendor-level Total row already shown inside the expanded row,
          // so renderReconTable() hides it based on this flag.
          isVendorFiltered: true,
        });

        this._oReconModel = oReconModel;
        this.byId("reconContainer").setModel(oReconModel, "recon");
      },
      renderOpenItemsTable: function (aData, oContainer) {
        oContainer.removeAllItems();

        if (!aData || aData.length === 0) {
          oContainer.addItem(new sap.m.Text({ text: "No open items found." }));
          return;
        }

        var oLocalModel = new sap.ui.model.json.JSONModel({ items: aData });

        var oTable = new sap.m.Table({
          inset: false,
          growing: true,
          columns: [
            new sap.m.Column({ header: new sap.m.Text({ text: "Doc No" }) }),
            new sap.m.Column({ header: new sap.m.Text({ text: "Doc Type" }) }),
            new sap.m.Column({
              header: new sap.m.Text({ text: "Posting Date" }),
            }),
            new sap.m.Column({ header: new sap.m.Text({ text: "Doc Date" }) }),
            new sap.m.Column({
              header: new sap.m.Text({ text: "Invoice Amt" }),
              hAlign: "End",
            }),
            new sap.m.Column({
              header: new sap.m.Text({ text: "Advance Amt" }),
              hAlign: "End",
            }),
            new sap.m.Column({
              header: new sap.m.Text({ text: "Net Amt" }),
              hAlign: "End",
            }),
          ],
        });

        oTable.bindItems({
          path: "/items",
          template: new sap.m.ColumnListItem({
            cells: [
              new sap.m.Text({ text: "{Belnr}" }),
              new sap.m.Text({ text: "{Blart}" }),
              new sap.m.Text({
                text: {
                  path: "Budat",
                  type: new sap.ui.model.type.Date({
                    pattern: "dd.MM.yyyy",
                    source: { pattern: "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'" },
                  }),
                },
              }),
              new sap.m.Text({
                text: {
                  path: "Bldat",
                  type: new sap.ui.model.type.Date({
                    pattern: "dd.MM.yyyy",
                    source: { pattern: "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'" },
                  }),
                },
              }),
              new sap.m.Text({
                text: {
                  path: "InvAmt",
                  type: new sap.ui.model.type.Float({
                    minFractionDigits: 2,
                    maxFractionDigits: 2,
                  }),
                },
              }),
              new sap.m.Text({
                text: {
                  path: "AdvAmt",
                  type: new sap.ui.model.type.Float({
                    minFractionDigits: 2,
                    maxFractionDigits: 2,
                  }),
                },
              }),
              new sap.m.Text({
                text: {
                  path: "NetAmt",
                  type: new sap.ui.model.type.Float({
                    minFractionDigits: 2,
                    maxFractionDigits: 2,
                  }),
                },
              }),
            ],
          }),
        });

        oTable.setModel(oLocalModel);
        oContainer.addItem(oTable);
      },

      onReset: function () {
        this.byId("inputBukrs").setValue("");
        this.byId("inputLifnr").setValue("");
        this.byId("inputKeyDate").setValue("");
        this.byId("reconContainer").removeAllItems();
      },

      // ══════════════════════════════════════════════════════════════════════════════
      //  LEVEL 1 : RECON TABLE
      // ══════════════════════════════════════════════════════════════════════════════

      loadRecon: function (sBukrs, sLifnr, sKeyDate) {
        var oModel = this.getOwnerComponent().getModel();
        if (!oModel) {
          console.error("No OData model found.");
          return;
        }

        this._sBukrs = sBukrs;
        this._sKeyDate = sKeyDate;

        var oContainer = this.byId("reconContainer");
        oContainer.setBusy(true);

        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Budat", FilterOperator.EQ, new Date(sKeyDate)),
        ];
        if (sLifnr) {
          aFilters.push(new Filter("Lifnr", FilterOperator.EQ, sLifnr));
        }

        var that = this;
        oModel.read("/ReconSet", {
          filters: aFilters,
          success: function (oData) {
            oContainer.setBusy(false);
            if (!oData.results || oData.results.length === 0) {
              MessageToast.show("No reconciliation records found.");
              return;
            }
            that._buildReconModel(oData.results);
            that.renderReconTable();
          },
          error: function (oError) {
            oContainer.setBusy(false);
            console.error("ReconSet read failed:", oError);
            MessageToast.show("Error loading data.");
          },
        });
      },

      // ── build the model for this call ────────────────────────────────────────
      _buildReconModel: function (aRecon) {
        var aItems = aRecon.map(function (oRecon) {
          return {
            Txt50: oRecon.Txt50,
            InvAmt: oRecon.InvAmt,
            AdvAmt: oRecon.AdvAmt,
            Akont: oRecon.Akont,
            Bukrs: oRecon.Bukrs,
            Lifnr: oRecon.Lifnr,

            // ── UI state for this row ──
            expanded: false,
            vendorsLoaded: false,
            vendorsBusy: false,
            vendors: [],
            vendorTotals: { InvAmt: 0, AdvAmt: 0, NetAmt: 0 },
          };
        });

        var nTotalInv = aItems.reduce(function (acc, o) {
          return acc + (parseFloat(o.InvAmt) || 0);
        }, 0);
        var nTotalAdv = aItems.reduce(function (acc, o) {
          return acc + (parseFloat(o.AdvAmt) || 0);
        }, 0);

        var oReconModel = new JSONModel({
          items: aItems,
          totals: { InvAmt: nTotalInv, AdvAmt: nTotalAdv },
          // Normal (non-vendor-filtered) search: the outer grand Total row
          // is meaningful here since it aggregates multiple recon rows.
          isVendorFiltered: false,
        });

        // Keep a reference so nested handlers (toggle, loadVendors, loadOpenItems)
        // can read/write it by path without needing to re-fetch the model each time.
        this._oReconModel = oReconModel;
        this.byId("reconContainer").setModel(oReconModel, "recon");
      },

      // ── render purely from the model ─────────────────────────────────────────
      renderReconTable: function () {
        var oContainer = this.byId("reconContainer");
        oContainer.removeAllItems();
        var that = this;

        var oWrapper = new VBox().addStyleClass("outerWrapper");

        // Header row (static)
        var oHeaderRow = new HBox({ alignItems: "Center" }).addStyleClass(
          "tableHeaderRow",
        );
        oHeaderRow.addItem(new Text({ text: "" }).addStyleClass("colToggle"));
        oHeaderRow.addItem(
          new Text({ text: "Category" }).addStyleClass(
            "colReconAcct colHeader",
          ),
        );
        oHeaderRow.addItem(
          new Text({ text: "Invoice Amount" }).addStyleClass(
            "colAmt colHeader",
          ),
        );
        oHeaderRow.addItem(
          new Text({ text: "Advance Amount" }).addStyleClass(
            "colAmt colHeader",
          ),
        );
        oWrapper.addItem(oHeaderRow);

        // Data rows — driven entirely by recon>/items
        var oRowsContainer = new VBox({
          items: {
            path: "recon>/items",
            factory: function (sId, oContext) {
              return that._createReconRow(sId, oContext);
            },
          },
        });
        oWrapper.addItem(oRowsContainer);

        // Totals row — bound to recon>/totals
        // Hidden when the search was vendor-filtered (Bukrs + Lifnr + KeyDate),
        // since in that case there is exactly one matched vendor row and its
        // own "Total" row (inside the expanded vendor section) already shows
        // the same figures — showing this outer Total too is redundant and,
        // worse, aggregates unfiltered recon amounts rather than the vendor's.
        var oTotalsRow = new HBox({
          alignItems: "Center",
          visible: "{= !${recon>/isVendorFiltered} }",
        }).addStyleClass("tableTotalsRow");
        oTotalsRow.addItem(new Text({ text: "" }).addStyleClass("colToggle"));
        oTotalsRow.addItem(
          new Text({ text: "Total" }).addStyleClass("colReconAcct totalLabel"),
        );
        oTotalsRow.addItem(
          new Text({
            text: { path: "recon>/totals/InvAmt", formatter: fnFmtAmt },
          }).addStyleClass("colAmt amtValue totalAmt"),
        );
        oTotalsRow.addItem(
          new Text({
            text: { path: "recon>/totals/AdvAmt", formatter: fnFmtAmt },
          }).addStyleClass("colAmt amtValue totalAmt"),
        );
        oWrapper.addItem(oTotalsRow);

        oContainer.addItem(oWrapper);
      },

      // ── factory: one recon row + its (lazily loaded) vendor section ─────────
      _createReconRow: function (sId, oContext) {
        var that = this;
        var sPath = oContext.getPath(); // e.g. /items/0

        var oToggleBtn = new Button({
          icon: {
            path: "recon>expanded",
            formatter: function (bExpanded) {
              return bExpanded
                ? "sap-icon://navigation-down-arrow"
                : "sap-icon://navigation-right-arrow";
            },
          },
          type: "Transparent",
        }).addStyleClass("toggleBtn colToggle");

        var oDataRow = new HBox({ alignItems: "Center" }).addStyleClass(
          "tableDataRow",
        );
        oDataRow.addItem(oToggleBtn);
        oDataRow.addItem(
          new Text({ text: "{recon>Txt50}" }).addStyleClass("colReconAcct"),
        );
        oDataRow.addItem(
          new Text({
            text: { path: "recon>InvAmt", formatter: fnFmtAmt },
          }).addStyleClass("colAmt amtValue"),
        );
        oDataRow.addItem(
          new Text({
            text: { path: "recon>AdvAmt", formatter: fnFmtAmt },
          }).addStyleClass("colAmt amtValue"),
        );

        var oVendorSection = this._createVendorSection();

        oToggleBtn.attachPress(function () {
          var oModel = that._oReconModel;
          var bExpanded = oModel.getProperty(sPath + "/expanded");
          oModel.setProperty(sPath + "/expanded", !bExpanded);

          var bVendorsLoaded = oModel.getProperty(sPath + "/vendorsLoaded");
          if (!bExpanded && !bVendorsLoaded) {
            that.loadVendors(oContext);
          }
        });

        return new VBox({ items: [oDataRow, oVendorSection] }).addStyleClass(
          "reconDataBlock",
        );
      },

      // ══════════════════════════════════════════════════════════════════════════════
      //  LEVEL 2 : VENDOR TABLE
      // ══════════════════════════════════════════════════════════════════════════════

      loadVendors: function (oReconContext) {
        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;
        var that = this;

        var sPath = oReconContext.getPath();
        var oRecon = oReconContext.getObject();

        var sBukrs = this.byId("inputBukrs").getValue().trim();
        var sKeyDate = this.byId("inputKeyDate").getValue().trim();
        var sAkont = String(oRecon.Akont).padStart(10, "0");

        oReconModel.setProperty(sPath + "/vendorsBusy", true);

        var aFilters = [
          new Filter("BUKRS", FilterOperator.EQ, sBukrs),
          new Filter("BUDAT", FilterOperator.EQ, new Date(sKeyDate)),
          new Filter("AKONT", FilterOperator.EQ, sAkont),
        ];

        oModel.read("/VENDERSet", {
          filters: aFilters,
          success: function (oData) {
            that._writeVendorsToModel(sPath, oData.results || []);
          },
          error: function (oError) {
            oReconModel.setProperty(sPath + "/vendorsBusy", false);
            oReconModel.setProperty(sPath + "/vendorsLoaded", true);
            console.error("VENDERSet read failed:", oError);
            MessageToast.show("Error loading vendor data.");
          },
        });
      },

      // ── write vendor results + totals into the recon model at sPath ─────────
      _writeVendorsToModel: function (sPath, aVendorResults) {
        var oReconModel = this._oReconModel;

        var aVendors = aVendorResults.map(function (oVendor) {
          return {
            LIFNR: oVendor.LIFNR,
            NAME1: oVendor.NAME1,
            AKONT: oVendor.AKONT,
            INV_AMT: oVendor.INV_AMT,
            ADV_AMT: oVendor.ADV_AMT,
            NET_AMT: oVendor.NET_AMT,

            // ── UI state for this vendor row ──
            expanded: false,
            itemsLoaded: false,
            itemsBusy: false,
            openItems: [],
          };
        });

        var nTotalInv = aVendors.reduce(function (acc, o) {
          return acc + (parseFloat(o.INV_AMT) || 0);
        }, 0);
        var nTotalAdv = aVendors.reduce(function (acc, o) {
          return acc + (parseFloat(o.ADV_AMT) || 0);
        }, 0);
        var nTotalNet = aVendors.reduce(function (acc, o) {
          return acc + (parseFloat(o.NET_AMT) || 0);
        }, 0);

        oReconModel.setProperty(sPath + "/vendors", aVendors);
        oReconModel.setProperty(sPath + "/vendorTotals", {
          InvAmt: nTotalInv,
          AdvAmt: nTotalAdv,
          NetAmt: nTotalNet,
        });
        oReconModel.setProperty(sPath + "/vendorsBusy", false);
        oReconModel.setProperty(sPath + "/vendorsLoaded", true);
      },

      // ── static shell for the vendor section: header, rows, totals, busy ─────
      _createVendorSection: function () {
        var that = this;

        var oVendorSection = new VBox({
          visible: "{recon>expanded}",
        }).addStyleClass("vendorSection");

        var oBusyIndicator = new BusyIndicator({
          visible: "{recon>vendorsBusy}",
        }).addStyleClass("vendorBusy");
        oVendorSection.addItem(oBusyIndicator);

        var oVHdrRow = new HBox({
          alignItems: "Center",
          visible: "{recon>vendorsLoaded}",
        }).addStyleClass("vendorHeaderRow");
        oVHdrRow.addItem(new Text({ text: "" }).addStyleClass("colToggle"));
        oVHdrRow.addItem(
          new Text({ text: "Vendor" }).addStyleClass("colVendorId colHeader"),
        );
        oVHdrRow.addItem(
          new Text({ text: "Name" }).addStyleClass("colVendorName colHeader"),
        );
        oVHdrRow.addItem(
          new Text({ text: "Invoice Amount" }).addStyleClass(
            "colAmt colHeader",
          ),
        );
        oVHdrRow.addItem(
          new Text({ text: "Advance Amount" }).addStyleClass(
            "colAmt colHeader",
          ),
        );
        oVHdrRow.addItem(
          new Text({ text: "Net Amount" }).addStyleClass("colAmt colHeader"),
        );
        oVendorSection.addItem(oVHdrRow);

        var oVendorRows = new VBox({
          items: {
            path: "recon>vendors", // relative — resolves against this row's context
            factory: function (sId, oContext) {
              return that._createVendorRow(sId, oContext);
            },
          },
        });
        oVendorSection.addItem(oVendorRows);

        // Hidden when the search was vendor-filtered: in that case there's
        // exactly one vendor row, so its own line already IS the total —
        // showing a "Total" row underneath it would just repeat the same
        // three numbers.
        var oVTotalsRow = new HBox({
          alignItems: "Center",
          visible: "{= ${recon>vendorsLoaded} && !${recon>/isVendorFiltered} }",
        }).addStyleClass("tableTotalsRow vendorTotalsRow");
        oVTotalsRow.addItem(new Text({ text: "" }).addStyleClass("colToggle"));
        oVTotalsRow.addItem(
          new Text({ text: "Total" }).addStyleClass("colVendorId totalLabel"),
        );
        oVTotalsRow.addItem(
          new Text({ text: "" }).addStyleClass("colVendorName"),
        );
        oVTotalsRow.addItem(
          new Text({
            text: { path: "recon>vendorTotals/InvAmt", formatter: fnFmtAmt },
          }).addStyleClass("colAmt amtValue totalAmt"),
        );
        oVTotalsRow.addItem(
          new Text({
            text: { path: "recon>vendorTotals/AdvAmt", formatter: fnFmtAmt },
          }).addStyleClass("colAmt amtValue totalAmt"),
        );
        oVTotalsRow.addItem(
          new Text({
            text: { path: "recon>vendorTotals/NetAmt", formatter: fnFmtAmt },
          }).addStyleClass("colAmt amtValue totalAmt"),
        );
        oVendorSection.addItem(oVTotalsRow);

        return oVendorSection;
      },

      // ── factory: one vendor row + its (lazily loaded) open-items section ────
      _createVendorRow: function (sId, oContext) {
        var that = this;
        var sPath = oContext.getPath(); // e.g. /items/0/vendors/2

        var oToggleBtn = new Button({
          icon: {
            path: "recon>expanded",
            formatter: function (bExpanded) {
              return bExpanded
                ? "sap-icon://navigation-down-arrow"
                : "sap-icon://navigation-right-arrow";
            },
          },
          type: "Transparent",
        }).addStyleClass("toggleBtn colToggle");

        var oVRow = new HBox({ alignItems: "Center" }).addStyleClass(
          "vendorDataRow",
        );
        oVRow.addItem(oToggleBtn);

        var oVendorLink = new Link({ text: "{recon>LIFNR}" }).addStyleClass(
          "colVendorId vendorLink",
        );
        oVendorLink.attachPress(function () {
          var oVendor = oContext.getObject();
          that
            .getOwnerComponent()
            .getRouter()
            .navTo("RouteDetail", {
              lifnr: encodeURIComponent(String(oVendor.LIFNR)),
              akont: encodeURIComponent(String(oVendor.AKONT)),
              name: encodeURIComponent(String(oVendor.NAME1)),
              bukrs: encodeURIComponent(
                that.byId("inputBukrs").getValue().trim(),
              ),
              budat: encodeURIComponent(
                that.byId("inputKeyDate").getValue().trim(),
              ),
              invAmt: encodeURIComponent(String(oVendor.INV_AMT)),
              advAmt: encodeURIComponent(String(oVendor.ADV_AMT)),
              netAmt: encodeURIComponent(String(oVendor.NET_AMT)),
            });
        });
        oVRow.addItem(oVendorLink);

        oVRow.addItem(
          new Text({ text: "{recon>NAME1}" }).addStyleClass("colVendorName"),
        );
        oVRow.addItem(
          new Text({
            text: { path: "recon>INV_AMT", formatter: fnFmtAmt },
          }).addStyleClass("colAmt amtValue"),
        );
        oVRow.addItem(
          new Text({
            text: { path: "recon>ADV_AMT", formatter: fnFmtAmt },
          }).addStyleClass("colAmt amtValue"),
        );
        oVRow.addItem(
          new Text({
            text: { path: "recon>NET_AMT", formatter: fnFmtAmt },
          }).addStyleClass("colAmt amtValue"),
        );

        var oItemsSection = this._createOpenItemsSection();

        oToggleBtn.attachPress(function () {
          var oModel = that._oReconModel;
          var bExpanded = oModel.getProperty(sPath + "/expanded");
          oModel.setProperty(sPath + "/expanded", !bExpanded);

          var bItemsLoaded = oModel.getProperty(sPath + "/itemsLoaded");
          if (!bExpanded && !bItemsLoaded) {
            that.loadOpenItems(oContext);
          }
        });

        return new VBox({ items: [oVRow, oItemsSection] }).addStyleClass(
          "vendorDataBlock",
        );
      },

      // ══════════════════════════════════════════════════════════════════════════════
      //  LEVEL 3 : OPEN ITEMS TABLE
      // ══════════════════════════════════════════════════════════════════════════════

      loadOpenItems: function (oVendorContext) {
        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this._oReconModel;
        var that = this;

        var sPath = oVendorContext.getPath();
        var oVendor = oVendorContext.getObject();

        var sBukrs = this.byId("inputBukrs").getValue().trim();
        var sKeyDate = this.byId("inputKeyDate").getValue().trim();
        var sAkont = String(oVendor.AKONT).padStart(10, "0");
        var sLifnr = String(oVendor.LIFNR);

        oReconModel.setProperty(sPath + "/itemsBusy", true);

        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, sBukrs),
          new Filter("Budat", FilterOperator.EQ, new Date(sKeyDate)),
          new Filter("Akont", FilterOperator.EQ, sAkont),
          new Filter("Lifnr", FilterOperator.EQ, sLifnr),
        ];

        oModel.read("/OpenItemsSet", {
          filters: aFilters,
          success: function (oData) {
            oReconModel.setProperty(sPath + "/openItems", oData.results || []);
            oReconModel.setProperty(sPath + "/itemsBusy", false);
            oReconModel.setProperty(sPath + "/itemsLoaded", true);
          },
          error: function (oError) {
            oReconModel.setProperty(sPath + "/itemsBusy", false);
            oReconModel.setProperty(sPath + "/itemsLoaded", true);
            console.error("OpenItemsSet read failed:", oError);
            MessageToast.show("Error loading open items.");
          },
        });
      },

      // ── static shell for the open-items section: busy + table bound to model ─
      _createOpenItemsSection: function () {
        var oItemsSection = new VBox({
          visible: "{recon>expanded}",
        }).addStyleClass("openItemsSection");

        var oBusyIndicator = new BusyIndicator({
          visible: "{recon>itemsBusy}",
        }).addStyleClass("itemsBusy");
        oItemsSection.addItem(oBusyIndicator);

        var oTable = new Table({
          inset: false,
          growing: true,
          growingThreshold: 20,
          showSeparators: "All",
          visible: "{recon>itemsLoaded}",
          items: {
            path: "recon>openItems", // relative — resolves against this vendor's context
            template: new ColumnListItem({
              cells: [
                new Text({ text: "{recon>Belnr}" }),
                new Text({ text: "{recon>Blart}" }),
                new Text({
                  text: { path: "recon>Budat", formatter: fnFmtDate },
                }),
                new Text({
                  text: { path: "recon>Bldat", formatter: fnFmtDate },
                }),
                new Text({ text: "{recon>Umskz}" }),
                new Text({ text: "{recon>Augbl}" }),
                new Text({
                  text: { path: "recon>InvAmt", formatter: fnFmtAmt },
                  textAlign: "End",
                }),
                new Text({
                  text: { path: "recon>AdvAmt", formatter: fnFmtAmt },
                  textAlign: "End",
                }),
                new Text({
                  text: { path: "recon>NetAmt", formatter: fnFmtAmt },
                  textAlign: "End",
                }),
              ],
            }),
          },
          columns: [
            new Column({
              header: new Label({ text: "Doc No" }),
              hAlign: "Begin",
            }),
            new Column({
              header: new Label({ text: "Doc Type" }),
              hAlign: "Begin",
            }),
            new Column({
              header: new Label({ text: "Posting Date" }),
              hAlign: "Begin",
            }),
            new Column({
              header: new Label({ text: "Doc Date" }),
              hAlign: "Begin",
            }),
            new Column({
              header: new Label({ text: "Spl G/L" }),
              hAlign: "Center",
            }),
            new Column({
              header: new Label({ text: "Clrng Doc" }),
              hAlign: "Begin",
            }),
            new Column({
              header: new Label({ text: "Invoice Amt" }),
              hAlign: "End",
            }),
            new Column({
              header: new Label({ text: "Advance Amt" }),
              hAlign: "End",
            }),
            new Column({
              header: new Label({ text: "Net Amt" }),
              hAlign: "End",
            }),
          ],
        }).addStyleClass("openItemsTable");

        oItemsSection.addItem(oTable);

        return oItemsSection;
      },
    });
  },
);
