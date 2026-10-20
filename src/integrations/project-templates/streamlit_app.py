import json
import streamlit as st
from run_queries import execute_query, project, parameter_values, result_column_labels

definition = project()
st.set_page_config(page_title=definition["title"], layout="wide")
st.title(definition["title"])
st.caption("Read-only DAX. Opening this app never queries a model. Results stay local.")
queries = {query["id"]: query for query in definition["queries"]}
selected = st.selectbox("Query", list(queries), format_func=lambda key: queries[key]["title"])
st.caption("Connection: " + queries[selected]["connection_name"])
if queries[selected].get("execution", {}).get("kind") == "contoso-retail":
    st.info("Synthetic Contoso retail: four fixed recipes using invented Desks, Chairs and Lamps sales. No real-model credentials needed.")
parameters = st.text_area("Parameter values (JSON object)", json.dumps(parameter_values(selected), indent=2), key="parameters-" + selected)
if st.button("Run query", type="primary"):
    try:
        values = json.loads(parameters)
        if not isinstance(values, dict):
            raise ValueError("Parameters must be a JSON object.")
        with st.spinner("Running the selected query..."):
            result = execute_query(selected, values)
        st.session_state["result"] = {"query": selected, "data": result}
    except Exception as error:
        st.error(str(error))
saved = st.session_state.get("result")
if saved:
    result = saved["data"]
    st.subheader(queries[saved["query"]]["title"] + " - captured result")
    st.caption(f"{result['rowCount']} captured rows. Exact decimals/integers remain strings.")
    if result.get("mode") == "synthetic":
        st.caption(result["notice"])
    if result.get("truncated"):
        st.warning("This capture is truncated. It is not the complete result.")
    labels = result_column_labels(result["columns"])
    # Display exact values; avoid inferred numeric conversion and duplicate-name loss.
    st.dataframe({str(i): [row[i] for row in result["rows"]] for i in range(len(result["columns"]))},
                 column_order=[str(i) for i in range(len(result["columns"]))],
                 column_config={str(i): st.column_config.Column(labels[i], help=column["name"])
                                for i, column in enumerate(result["columns"])})
    st.download_button("Download captured JSON", json.dumps(result, ensure_ascii=False), "result.json", "application/json")
