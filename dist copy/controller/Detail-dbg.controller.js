sap.ui.define(
  [
    "sap/ui/core/mvc/Controller",
    "sap/f/LayoutType",
    "sap/ui/core/mvc/XMLView",
    "sap/ui/core/Fragment",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/m/MessageToast",
  ],
  function (
    Controller,
    LayoutType,
    XMLView,
    Fragment,
    Filter,
    FilterOperator,
    MessageToast,
  ) {
    "use strict";

    return Controller.extend("supplieropenitems.controller.Detail", {
      onInit: function () {
        var oRouter = this.getOwnerComponent().getRouter();
        oRouter
          .getRoute("detail")
          .attachPatternMatched(this._onDetailMatched, this);
      },

      _onDetailMatched: function (oEvent) {
        var sIndex = oEvent.getParameter("arguments").index;
        var sItemPath = "/items/" + sIndex;

        this.getView().bindElement({
          path: sItemPath,
          model: "recon",
        });

        this._sItemPath = sItemPath;

        // Reset vendor filter field whenever we navigate to a (possibly new) category
        var oVendorFilterInput = this.byId("vendorFilterInput");
        if (oVendorFilterInput) {
          oVendorFilterInput.setValue("");
        }

        // Reset open items tab on every category navigation
        var oReconModel = this.getOwnerComponent().getModel("recon");
        oReconModel.setProperty("/openItemsTabVisible", false);
        oReconModel.setProperty("/openItems", []);
        oReconModel.setProperty("/openItemsBusy", false);
        oReconModel.setProperty("/reCount", 0);
        oReconModel.setProperty("/nonReCount", 0);
        oReconModel.setProperty("/reNetTotal", 0);
        oReconModel.setProperty("/nonReNetTotal", 0);
        oReconModel.setProperty("/filteredOpenItems", []);
        oReconModel.setProperty("/filteredOpenItemsTitle", "");

        if (!this._bChartInitialized) {
          this._initChart();
          this._initDonutChart();
          this._bChartInitialized = true;
        }

        // Rebuild dashboard data every time (cheap) — avoids a stale/empty
        // "No data" state if /items wasn't fully populated on first run.
        this._buildDashboardData();

        var that = this;
        setTimeout(function () {
          var oChart = that.byId("reconChart");
          if (oChart && oChart.getDomRef()) {
            oChart.invalidate();
          }
        }, 300);

        var bVendorsLoaded = oReconModel.getProperty(
          sItemPath + "/vendorsLoaded",
        );

        if (!bVendorsLoaded) {
          this._getMainController().loadVendorsForCategory(sItemPath);
        }
      },

      _initChart: function () {
        var oViz = this.byId("reconChart");
        if (!oViz) return;

        oViz.setVizProperties({
          title: { visible: false },
          legend: { visible: true },
          legendGroup: { layout: { position: "bottom" } },
          plotArea: {
            colorPalette: ["#f2790f", "#5b738b"],
            dataLabel: { visible: false },
            gridline: { visible: true },
            gap: { barSpacing: 0.15, groupSpacing: 0.5 },
          },
          categoryAxis: {
            title: { visible: true, text: "Category" },
            label: {
              rotation: -45,
              autoRotate: false,
              showAllLabels: true,
              style: { fontSize: "10px" },
            },
          },
          valueAxis: {
            title: { visible: true, text: "Amount" },
            label: { formatString: "#,##0", style: { fontSize: "11px" } },
          },
          interaction: { selectability: { mode: "single" } },
        });
      },

      _initDonutChart: function () {
        var oViz = this.byId("netDonutChart");
        if (!oViz) return;

        oViz.setVizProperties({
          title: { visible: false },
          legend: { visible: true, position: "bottom" },
          plotArea: {
            colorPalette: [
              "#3979c9",
              "#8e6fce",
              "#4caf7d",
              "#e0559b",
              "#e8791e",
              "#b3261e",
              "#2fa3a1",
              "#46587f",
              "#8a8d91",
              "#d4a017",
            ],
            dataLabel: { visible: false },
          },
          interaction: { selectability: { mode: "single" } },
        });
      },

      // ═══════════════════════════════════════════════════════════════════
      //  DASHBOARD DATA (Top 5 by Net Amount + Net Amount Distribution donut)
      //  Built once from the full /items list already loaded by Main
      // ═══════════════════════════════════════════════════════════════════
      _buildDashboardData: function () {
        var oReconModel = this.getOwnerComponent().getModel("recon");
        var aItems = oReconModel.getProperty("/items") || [];
        var that = this;

        // /items can momentarily be empty if this runs before Main's
        // ReconSet read has landed on the model — retry once, shortly after.
        if (aItems.length === 0) {
          setTimeout(function () {
            that._buildDashboardData();
          }, 400);
          return;
        }

        var COLOR_CLASSES = [
          "donutDotBlue",
          "donutDotPurple",
          "donutDotGreen",
          "donutDotPink",
          "donutDotOrange",
          "donutDotRed",
          "donutDotTeal",
          "donutDotIndigo",
          "donutDotGray",
          "donutDotYellow",
        ];
        var COLOR_HEX = [
          "#3979c9",
          "#8e6fce",
          "#4caf7d",
          "#e0559b",
          "#e8791e",
          "#b3261e",
          "#2fa3a1",
          "#46587f",
          "#8a8d91",
          "#d4a017",
        ];

        var aCategories = aItems.map(function (o) {
          var fNet = (parseFloat(o.InvAmt) || 0) + (parseFloat(o.AdvAmt) || 0);
          return {
            category: that.formatCategoryShort(o.Txt50),
            netAmt: fNet,
            absNetAmt: Math.abs(fNet),
          };
        });

        var fTotalNet = aCategories.reduce(function (fSum, o) {
          return fSum + o.netAmt;
        }, 0);

        // ── Top 5 by Net Amount (descending) ──
        var aTop5 = aCategories
          .slice()
          .sort(function (a, b) {
            return b.netAmt - a.netAmt;
          })
          .slice(0, 5);

        var fMaxAbs = aTop5.reduce(function (fMax, o) {
          return Math.max(fMax, Math.abs(o.netAmt));
        }, 1);

        aTop5.forEach(function (o) {
          o.percent = Math.round((Math.abs(o.netAmt) / fMaxAbs) * 100);
          o.state = o.netAmt >= 0 ? "Success" : "Error";
        });

        // ── Donut: share of total net amount, with a legend color per slice ──
        var aDonut = aCategories.map(function (o, i) {
          var fPercent = fTotalNet !== 0 ? (o.netAmt / fTotalNet) * 100 : 0;
          return {
            category: o.category,
            netAmt: o.netAmt,
            absNetAmt: o.absNetAmt,
            percentLabel: fPercent.toFixed(1) + "%",
            colorClass: COLOR_CLASSES[i % COLOR_CLASSES.length],
            colorHex: COLOR_HEX[i % COLOR_HEX.length],
          };
        });

        oReconModel.setProperty("/top5Categories", aTop5);
        oReconModel.setProperty("/donut", aDonut);
      },

      _getMainController: function () {
        return this.getOwnerComponent().getRootControl().getController();
      },

      formatAmount: function (val) {
        if (val === null || val === undefined || val === "") return "";
        return parseFloat(val).toLocaleString("en-IN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      },

      formatNetAmount: function (fInv, fAdv) {
        var fNet = (parseFloat(fInv) || 0) + (parseFloat(fAdv) || 0);
        return this.formatAmount(fNet);
      },

      formatCategoryShort: function (sTxt) {
        if (!sTxt) return "";
        var i = sTxt.indexOf("-");
        return i > -1 ? sTxt.substring(i + 1).trim() : sTxt;
      },

      // ═══════════════════════════════════════════════════════════════════
      //  VENDOR TABLE FILTER (Tab 2 — filter by LIFNR or NAME1)
      //  Client-side filter over the already-loaded recon>vendors list —
      //  no extra OData round-trip since the data is already on the model.
      // ═══════════════════════════════════════════════════════════════════
      onVendorFilterChange: function (oEvent) {
        var sValue = (
          oEvent.getParameter("newValue") ||
          oEvent.getParameter("value") ||
          ""
        ).trim();

        var oTable = this.byId("vendorTable");
        if (!oTable) return;

        var oBinding = oTable.getBinding("items");
        if (!oBinding) return;

        if (!sValue) {
          oBinding.filter([]);
          return;
        }

        var oFilter = new Filter({
          filters: [
            new Filter("LIFNR", FilterOperator.Contains, sValue),
            new Filter("NAME1", FilterOperator.Contains, sValue),
          ],
          and: false,
        });

        oBinding.filter([oFilter]);
      },

      /** Shows "X of Y vendors" next to the filter field, reacting to the full vendors array. */
      formatVendorCount: function (aVendors) {
        if (!aVendors) return "";
        var oTable = this.byId("vendorTable");
        var iVisible = aVendors.length;

        if (oTable) {
          var oBinding = oTable.getBinding("items");
          if (oBinding) {
            iVisible = oBinding.getLength();
          }
        }

        return iVisible === aVendors.length
          ? aVendors.length + " vendors"
          : iVisible + " of " + aVendors.length + " vendors";
      },

      // ═══════════════════════════════════════════════════════════════════
      //  VENDOR ROW PRESS → load open items in tab + navigate via NavContainer
      // ═══════════════════════════════════════════════════════════════════
      onVendorPress: function (oEvent) {
        var oItem = oEvent.getSource();
        var oCtx = oItem.getBindingContext("recon");
        var oVendor = oCtx.getObject();
        var sVendorPath = oCtx.getPath();
        var sVendorIndex = sVendorPath.split("/").pop();
        var sIndex = this._sItemPath.split("/").pop();

        // ── Read filter values from Main controller inputs ──
        var oMainController = this._getMainController();
        var sBukrs = oMainController.byId("inputBukrs").getValue().trim();
        var sKeyDate = oMainController.byId("inputKeyDate").getValue().trim();
        var sAkont = String(oVendor.AKONT).padStart(10, "0");
        var sLifnr = String(oVendor.LIFNR);

        // ── Store all filter values in recon model ──
        var oReconModel = this.getOwnerComponent().getModel("recon");
        oReconModel.setProperty("/selectedVendorFilters", {
          Bukrs: sBukrs,
          KeyDate: sKeyDate,
          Akont: sAkont,
          Lifnr: sLifnr,
          vendorPath: sVendorPath,
          reconIndex: sIndex,
          vendorIndex: sVendorIndex,
        });

        console.log("➡️ Vendor selected — filters stored:", {
          Bukrs: sBukrs,
          KeyDate: sKeyDate,
          Akont: sAkont,
          Lifnr: sLifnr,
        });

        // ── Show Open Items tab and load data ──
        oReconModel.setProperty("/openItemsTabVisible", true);
        this._loadOpenItems({
          Bukrs: sBukrs,
          KeyDate: sKeyDate,
          Akont: sAkont,
          Lifnr: sLifnr,
        });

        // ── Auto-scroll to Open Items section ──
        var that = this;
        setTimeout(function () {
          var oObjectPage = that.byId("ObjectPageLayout");
          var oSection = that.byId("openItemsSection");
          if (oObjectPage && oSection) {
            oObjectPage.setSelectedSection(oSection);
          }
        }, 300);
      },

      // ═══════════════════════════════════════════════════════════════════
      //  LOAD OPEN ITEMS
      // ═══════════════════════════════════════════════════════════════════
      _loadOpenItems: function (oFilters) {
        var oModel = this.getOwnerComponent().getModel();
        var oReconModel = this.getOwnerComponent().getModel("recon");

        oReconModel.setProperty("/openItemsBusy", true);

        var aFilters = [
          new Filter("Bukrs", FilterOperator.EQ, oFilters.Bukrs),
          new Filter("Budat", FilterOperator.EQ, new Date(oFilters.KeyDate)),
          new Filter("Akont", FilterOperator.EQ, oFilters.Akont),
          new Filter("Lifnr", FilterOperator.EQ, oFilters.Lifnr),
        ];

        console.log("🔍 Calling /OpenItemsSet with filters:", {
          Bukrs: oFilters.Bukrs,
          Budat: oFilters.KeyDate,
          Akont: oFilters.Akont,
          Lifnr: oFilters.Lifnr,
        });

        var that = this;

        oModel.read("/OpenItemsSet", {
          filters: aFilters,
          success: function (oData) {
            console.log("✅ OpenItemsSet response:", oData.results);
            var aResults = oData.results || [];

            oReconModel.setProperty("/openItems", aResults);
            that._computeOpenItemsSummary(aResults);
            oReconModel.setProperty("/openItemsBusy", false);
          },
          error: function (oError) {
            console.error("❌ OpenItemsSet read failed:", oError);
            oReconModel.setProperty("/openItems", []);
            that._computeOpenItemsSummary([]);
            oReconModel.setProperty("/openItemsBusy", false);
            MessageToast.show("Error loading open items.");
          },
        });
      },

      // ═══════════════════════════════════════════════════════════════════
      //  SUMMARY (RE / Non-RE counts + net totals) FOR THE TWO TILES
      // ═══════════════════════════════════════════════════════════════════
      _computeOpenItemsSummary: function (aResults) {
        var oReconModel = this.getOwnerComponent().getModel("recon");

        var iReCount = 0;
        var iNonReCount = 0;
        var fReNet = 0;
        var fNonReNet = 0;

        aResults.forEach(function (oDoc) {
          var fNet = parseFloat(oDoc.NetAmt) || 0;
          if (oDoc.Blart === "RE") {
            iReCount++;
            fReNet += fNet;
          } else {
            iNonReCount++;
            fNonReNet += fNet;
          }
        });

        oReconModel.setProperty("/reCount", iReCount);
        oReconModel.setProperty("/nonReCount", iNonReCount);
        oReconModel.setProperty("/reNetTotal", fReNet);
        oReconModel.setProperty("/nonReNetTotal", fNonReNet);
      },

      // ═══════════════════════════════════════════════════════════════════
      //  TILE FORMATTERS (Open Items tab)
      // ═══════════════════════════════════════════════════════════════════
      formatTileValue: function (val) {
        if (val === null || val === undefined || val === "") return "0.00";
        return parseFloat(val).toLocaleString("en-IN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      },

      formatSummaryFooter: function (fNet) {
        return "Net: " + this.formatTileValue(fNet);
      },

      // ═══════════════════════════════════════════════════════════════════
      //  SUMMARY TILE PRESS → toast + open fragment dialog with filtered table
      // ═══════════════════════════════════════════════════════════════════
      onSummaryTilePress: function (oEvent) {
        var oTile = oEvent.getSource();
        var sDocType = oTile.data("docType"); // "RE" or "NONRE"
        var oReconModel = this.getOwnerComponent().getModel("recon");
        var aAll = oReconModel.getProperty("/openItems") || [];
        var aFiltered;
        var sTitle;

        if (sDocType === "RE") {
          aFiltered = aAll.filter(function (o) {
            return o.Blart === "RE";
          });
          sTitle = "RE Documents";
          MessageToast.show("You clicked RE");
        } else {
          aFiltered = aAll.filter(function (o) {
            return o.Blart !== "RE";
          });
          sTitle = "Non-RE Documents";
          MessageToast.show("You clicked Non-RE");
        }

        oReconModel.setProperty("/filteredOpenItems", aFiltered);
        oReconModel.setProperty("/filteredOpenItemsTitle", sTitle);

        this._openOpenItemsDetailDialog();
      },

      _openOpenItemsDetailDialog: function () {
        var oView = this.getView();
        var that = this;

        if (!this._pOpenItemsDetailDialog) {
          this._pOpenItemsDetailDialog = Fragment.load({
            id: oView.getId(),
            name: "supplieropenitems.view.fragment.Openitemsdetail",
            controller: this,
          }).then(function (oDialog) {
            oView.addDependent(oDialog);
            return oDialog;
          });
        }

        this._pOpenItemsDetailDialog.then(function (oDialog) {
          oDialog.open();
        });
      },

      onCloseOpenItemsDetail: function (oEvent) {
        oEvent.getSource().getParent().close();
      },

      // ═══════════════════════════════════════════════════════════════════
      //  FCL COLUMN ACTIONS
      // ═══════════════════════════════════════════════════════════════════
      handleCategoryTable: function () {
        var oLayoutModel = this.getOwnerComponent().getModel("layout");
        var sCurrentLayout = oLayoutModel.getProperty("/layout");

        if (sCurrentLayout === LayoutType.MidColumnFullScreen) {
          oLayoutModel.setProperty("/layout", LayoutType.TwoColumnsMidExpanded);
        } else {
          oLayoutModel.setProperty("/layout", LayoutType.OneColumn);
          this.getOwnerComponent().getRouter().navTo("begin");
        }
      },

      handleFullScreen: function () {
        this.getOwnerComponent()
          .getModel("layout")
          .setProperty("/layout", LayoutType.MidColumnFullScreen);
      },

      handleExitFullScreen: function () {
        this.getOwnerComponent()
          .getModel("layout")
          .setProperty("/layout", LayoutType.TwoColumnsMidExpanded);
      },

      handleClose: function () {
        this.getOwnerComponent()
          .getModel("layout")
          .setProperty("/layout", LayoutType.OneColumn);
        this.getOwnerComponent().getRouter().navTo("begin");
      },
    });
  },
);
